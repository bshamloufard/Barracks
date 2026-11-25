import {
  findCatalogueProvider,
  findLargestMaxOutputTokens,
  findModelLimits,
} from "@barrack/model-catalogue";
import { maximumModelIdLength, maximumTokensPerAnswer } from "@barrack/protocol";
import type { AnswerUsage } from "../model-usage/model-usage-store.js";
import type { ScannedJsonBody } from "./json-body-scanner.js";
import type { ReasoningRequest } from "./reasoning-request.js";
import type { RelayOutcome } from "./relay-request.js";
import type { MeteredUsage } from "./usage-meter.js";

/** What the request asked for, as the proxy read it. */
export type RequestedAnswer = {
  model: string;
  isStreamed: boolean;
  /** The input the relayed body suggests, in tokens (`estimateInputTokens`). */
  estimatedInputTokens: number;
  /** The most output the answer may hold (`resolveMaximumOutputTokens`). */
  maximumOutputTokens: number;
  /** Whether the model may reason before any output is seen (`mayReasonUnseen`). */
  mayReasonUnseen: boolean;
};

/** Roughly what a token is worth in bytes of text, for English and code alike. */
const bytesPerToken = 4;

/**
 * What one image is counted as, whatever its bytes: a provider counts an
 * image by its size in pixels, not by its file's bytes, and a desktop
 * screenshot of a few hundred kilobytes is a thousand or two tokens. The
 * largest any relayed provider documents for an image at its default
 * detail is Anthropic's 4,784 for its high-resolution tier (OpenAI's
 * patch-based models cap at 3,000 at high detail, xAI at 1,792); this is
 * above all of them. Two cases can cost more and are counted low: OpenAI's
 * `original` detail (up to 30,000 patches) and the few models OpenAI bills
 * many times over per tile.
 * https://platform.claude.com/docs/en/build-with-claude/vision
 * https://developers.openai.com/api/docs/guides/images-vision
 * https://docs.x.ai/docs/guides/image-understanding
 */
export const tokensPerImage = 5_000;

/**
 * The output counted for a request that states no maximum, for a model
 * neither the catalogue nor its provider's list gives one for: none of the
 * relayed providers' flagship models allows more than this, though some
 * hosts list models that do (and those are counted at their own).
 */
export const defaultMaximumOutputTokens = 128_000;

type CountedUsage = Omit<AnswerUsage, "ownerUserId" | "threadId" | "providerId" | "at">;

/**
 * The input a relayed body suggests, erring high: its bytes over four,
 * leaving out the whitespace between tokens, which no provider counts, and
 * the base64 data of its images, each counted at `tokensPerImage` instead.
 */
export function estimateInputTokens(relayedBytes: number, scanned: ScannedJsonBody): number {
  const textBytes = Math.max(
    0,
    relayedBytes - scanned.insignificantBytes - scanned.base64ImageBytes,
  );
  return Math.ceil(textBytes / bytesPerToken) + scanned.imageCount * tokensPerImage;
}

/**
 * The most output an answer may hold: what the request states, which the
 * provider enforces; failing that, the model's own maximum as the pinned
 * agent lists it; failing that, the largest of any model it lists for the
 * provider; and failing that, `defaultMaximumOutputTokens`.
 */
export function resolveMaximumOutputTokens(
  providerId: string,
  model: string,
  stated: number | undefined,
): number {
  return (
    stated ??
    findModelLimits(providerId, model)?.maxOutputTokens ??
    findLargestMaxOutputTokens(providerId) ??
    defaultMaximumOutputTokens
  );
}

/**
 * Whether the model may generate reasoning that a streamed answer does not
 * show: when the request asks for it; when it says neither way, for a model
 * that reasons unless told not to, which is every model the catalogue says
 * reasons, and any it does not list, but none of Anthropic's, which reason
 * only when asked (https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking).
 */
export function mayReasonUnseen(
  providerId: string,
  model: string,
  reasoningRequest: ReasoningRequest,
): boolean {
  if (reasoningRequest !== "unstated") {
    return reasoningRequest === "on";
  }
  if (providerId === "anthropic") {
    return false;
  }
  const listed = findCatalogueProvider(providerId)?.models.find(
    (candidate) => candidate.modelId === model,
  );
  return listed?.reasoning ?? true;
}

/**
 * What to count for one relayed request:
 * - the provider's own figures when it gave them (`measured`);
 * - for a request the provider received whole but whose answer never began
 *   to arrive (the agent hung up, a limit or a stop ended it), an estimate
 *   (`estimated`) at the most output the request allowed: a non-streamed
 *   answer's headers come only once it is all generated, so the provider
 *   has probably billed it in full by then;
 * - for an answer that began but ended without the provider's figures, an
 *   estimate too: the input as the provider reported it or as the body
 *   suggests, and the output as the larger of what was seen generated and
 *   what could have been generated unseen. That is the most the request
 *   allowed for a non-streamed answer, which arrives whole once generated,
 *   and for a streamed one whose model may have reasoned without showing
 *   it, or showed reasoning begin; otherwise it is what was seen. A user
 *   who stops a thread mid-answer on a model that reasons is therefore
 *   counted high.
 * Without these an agent could hang up before every answer ended and never
 * be counted. A request the provider refused, or never received whole,
 * counts nothing. Estimates err high, by design.
 */
export function describeAnswerUsage(
  outcome: Pick<
    RelayOutcome,
    "upstreamStatus" | "interruption" | "wasRequestSent" | "responseBytes" | "usage"
  >,
  requested: RequestedAnswer,
): CountedUsage | undefined {
  const { usage, upstreamStatus } = outcome;
  if (upstreamStatus === undefined || usage === undefined) {
    return outcome.wasRequestSent ? estimateUnanswered(requested) : undefined;
  }
  if (upstreamStatus >= 300) {
    return undefined;
  }
  const modelId = boundedModelId(usage.modelId ?? requested.model);
  if (usage.isFinal && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    return {
      modelId,
      source: "measured",
      inputTokens: bounded(usage.inputTokens),
      outputTokens: bounded(usage.outputTokens),
      cacheReadTokens: bounded(usage.cacheReadTokens),
      cacheWriteTokens: bounded(usage.cacheWriteTokens),
    };
  }
  return {
    modelId,
    source: "estimated",
    inputTokens: bounded(usage.inputTokens ?? requested.estimatedInputTokens),
    outputTokens: bounded(estimateOutput(usage, requested)),
    cacheReadTokens: bounded(usage.cacheReadTokens),
    cacheWriteTokens: bounded(usage.cacheWriteTokens),
  };
}

function estimateUnanswered(requested: RequestedAnswer): CountedUsage {
  return {
    modelId: boundedModelId(requested.model),
    source: "estimated",
    inputTokens: bounded(requested.estimatedInputTokens),
    outputTokens: bounded(requested.maximumOutputTokens),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function estimateOutput(usage: MeteredUsage, requested: RequestedAnswer): number {
  const seenGenerated = Math.max(
    usage.outputTokens ?? 0,
    Math.ceil(usage.generatedCharacters / bytesPerToken),
  );
  const mayHaveGeneratedUnseen =
    !requested.isStreamed || requested.mayReasonUnseen || usage.sawReasoning;
  return mayHaveGeneratedUnseen
    ? Math.max(seenGenerated, requested.maximumOutputTokens)
    : seenGenerated;
}

function boundedModelId(modelId: string): string {
  return modelId.slice(0, maximumModelIdLength);
}

function bounded(tokens: number): number {
  return Math.min(tokens, maximumTokensPerAnswer);
}
