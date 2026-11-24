import type { ModelUsageSource, ModelUsageTotals } from "@barrack/protocol";

/**
 * The tokens each user's threads have used, added up per thread, model,
 * source and hour, and the cap each user may set on themselves. Adding is
 * one atomic step, so answers counted at once by two requests, or by two
 * control plane instances, all count.
 */
export interface ModelUsageStore {
  /** Adds one answer's tokens to the hour `at` falls in. */
  add(usage: AnswerUsage): Promise<void>;

  /** Measured and estimated tokens (input, output and cache together) since `since`. */
  countCappedTokensSince(ownerUserId: string, since: Date): Promise<number>;

  /** The user's totals since `since`, by model and source. */
  listForUserSince(ownerUserId: string, since: Date): Promise<ModelUsageTotals[]>;

  /** Everything the thread has used, by model and source. */
  listForThread(ownerUserId: string, threadId: string): Promise<ModelUsageTotals[]>;

  /** The cap the user set on themselves, or undefined. */
  readOwnCap(ownerUserId: string): Promise<number | undefined>;

  /** Sets the user's own cap, or removes it with undefined. */
  setOwnCap(ownerUserId: string, capTokens: number | undefined): Promise<void>;
}

/** What one answer of a model used, and how that was counted. */
export type AnswerUsage = {
  ownerUserId: string;
  threadId: string;
  providerId: string;
  modelId: string;
  source: ModelUsageSource;
  at: Date;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** The start of the hour `at` falls in: rows are kept per hour, so the table stays small. */
export function hourOf(at: Date): Date {
  const hour = new Date(at);
  hour.setUTCMinutes(0, 0, 0);
  return hour;
}

/** Orders totals by provider, model, then source, as both stores answer. */
export function compareTotals(first: ModelUsageTotals, second: ModelUsageTotals): number {
  return (
    first.providerId.localeCompare(second.providerId) ||
    first.modelId.localeCompare(second.modelId) ||
    first.source.localeCompare(second.source)
  );
}
