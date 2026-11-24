import { maximumModelIdLength, maximumTokensPerAnswer } from "@barrack/protocol";
import type { AnswerUsage } from "../model-usage/model-usage-store.js";
import type { RelayOutcome } from "./relay-request.js";
import type { MeteredUsage } from "./usage-meter.js";

/** What the request asked for, as the proxy read it. */
export type RequestedAnswer = {
  model: string;
  /** The size of the request's body as the agent sent it. */
  requestBytes: number;
  maximumOutputTokens: number | undefined;
  isStreamed: boolean;
};

/** Roughly what a token is worth in characters, for English and code alike. */
const charactersPerToken = 4;

/**
 * The output counted for an unanswered request that stated no maximum. Of
 * the relayed formats only Anthropic's requires one; a provider otherwise
 * stops at the model's own limit, which for current models is tens of
 * thousands of tokens and for some more. Erring high is the safe side: it
 * counts against the cap only requests that were never answered, which the
 * agent's own client, always streaming and always stating a maximum, does
 * not leave so.
 */
export const defaultMaximumOutputTokens = 32_768;

type CountedUsage = Omit<AnswerUsage, "ownerUserId" | "threadId" | "providerId" | "at">;

/**
 * What to count for one relayed request:
 * - the provider's own figures when it gave them (`measured`);
 * - for a request the provider received whole but whose answer never began
 *   to arrive (the agent hung up, a limit or a stop ended it), an estimate
 *   (`estimated`) at the most output the request allowed: a non-streamed
 *   answer's headers come only once it is all generated, so the provider
 *   has probably billed it in full by then;
 * - for an answer that began but ended without the provider's figures, an
 *   estimate too: the input as the provider reported it or as the request's
 *   size suggests, and the output from what was seen generated, or, for a
 *   non-streamed answer, which arrives whole once generated, the most the
 *   request allowed.
 * Without these an agent could hang up before every answer ended and never
 * be counted. A request the provider refused, or never received whole,
 * counts nothing.
 */
export function describeAnswerUsage(
  outcome: RelayOutcome,
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
    inputTokens: bounded(usage.inputTokens ?? estimateInput(requested)),
    outputTokens: bounded(estimateOutput(usage, requested)),
    cacheReadTokens: bounded(usage.cacheReadTokens),
    cacheWriteTokens: bounded(usage.cacheWriteTokens),
  };
}

function estimateUnanswered(requested: RequestedAnswer): CountedUsage {
  return {
    modelId: boundedModelId(requested.model),
    source: "estimated",
    inputTokens: bounded(estimateInput(requested)),
    outputTokens: bounded(requested.maximumOutputTokens ?? defaultMaximumOutputTokens),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function estimateInput(requested: RequestedAnswer): number {
  return Math.ceil(requested.requestBytes / charactersPerToken);
}

function estimateOutput(usage: MeteredUsage, requested: RequestedAnswer): number {
  const seenGenerated = Math.max(
    usage.outputTokens ?? 0,
    Math.ceil(usage.generatedCharacters / charactersPerToken),
  );
  if (requested.isStreamed) {
    return seenGenerated;
  }
  return Math.max(seenGenerated, requested.maximumOutputTokens ?? defaultMaximumOutputTokens);
}

function boundedModelId(modelId: string): string {
  return modelId.slice(0, maximumModelIdLength);
}

function bounded(tokens: number): number {
  return Math.min(tokens, maximumTokensPerAnswer);
}
