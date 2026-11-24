import { maximumModelIdLength, maximumTokensPerAnswer } from "@barrack/protocol";
import type { AnswerUsage } from "../model-usage/model-usage-store.js";
import type { RelayOutcome } from "./relay-request.js";

/** Roughly what a token is worth in characters, for English and code alike. */
const charactersPerToken = 4;

/**
 * What to count for one relayed answer: the provider's own figures when it
 * gave them (`measured`); otherwise, for an answer that began and was cut
 * short, an estimate (`estimated`): the input as the provider reported it
 * or as the request's size suggests, and the output from what was seen
 * generated. Without that, an agent could hang up just before the end of
 * every answer and never be counted. A refused request, or one the provider
 * never began answering, is billed nothing and counts nothing.
 */
export function describeAnswerUsage(
  outcome: RelayOutcome,
): Omit<AnswerUsage, "ownerUserId" | "threadId" | "providerId" | "at"> | undefined {
  const { usage, upstreamStatus } = outcome;
  if (usage === undefined || upstreamStatus === undefined || upstreamStatus >= 300) {
    return undefined;
  }
  const modelId = (usage.modelId ?? "unknown").slice(0, maximumModelIdLength);
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
  const estimatedOutput = Math.ceil(usage.generatedCharacters / charactersPerToken);
  return {
    modelId,
    source: "estimated",
    inputTokens: bounded(usage.inputTokens ?? Math.ceil(outcome.requestBytes / charactersPerToken)),
    outputTokens: bounded(Math.max(usage.outputTokens ?? 0, estimatedOutput)),
    cacheReadTokens: bounded(usage.cacheReadTokens),
    cacheWriteTokens: bounded(usage.cacheWriteTokens),
  };
}

function bounded(tokens: number): number {
  return Math.min(tokens, maximumTokensPerAnswer);
}
