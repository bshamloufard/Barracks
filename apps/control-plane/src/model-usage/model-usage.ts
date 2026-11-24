import type { ModelUsageTotals, UserModelUsageResponse } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { AnswerUsage, ModelUsageStore } from "./model-usage-store.js";

/**
 * The installation's cap on every user's model usage, if any, and the
 * window it counts over. A user may set a lower cap of their own.
 */
export type ModelUsageCapSettings = {
  installationCapTokens: number | undefined;
  windowHours: number;
};

export type UsageCapCheck =
  | { isReached: false }
  | { isReached: true; capTokens: number; countedTokens: number; windowHours: number };

/**
 * Pauses before trying a failed usage write again: enough to ride out a
 * database blip or a pool briefly exhausted, and short enough to finish
 * within a shutdown's grace period.
 */
const defaultRecordRetryDelays = [250, 1_000, 4_000];

/** How many days of usage the settings page shows. */
export const recentUsageDays = 30;

/**
 * Counts each user's model usage and decides whether their cap is reached.
 * Only what the model proxy counted (measured, or estimated where an answer
 * was cut short) counts towards the cap; what a sandbox reports is kept to
 * be shown, never trusted to limit or to free anything.
 */
export class ModelUsage {
  readonly #store: ModelUsageStore;
  readonly #settings: ModelUsageCapSettings;
  readonly #clock: () => Date;
  readonly #logger: Logger;
  readonly #recordRetryDelays: readonly number[];

  constructor(options: {
    store: ModelUsageStore;
    settings: ModelUsageCapSettings;
    clock?: () => Date;
    logger: Logger;
    /** The pauses before each further try of a failed write; `defaultRecordRetryDelays` unless given. */
    recordRetryDelaysInMilliseconds?: readonly number[];
  }) {
    this.#store = options.store;
    this.#settings = options.settings;
    this.#clock = options.clock ?? (() => new Date());
    this.#logger = options.logger;
    this.#recordRetryDelays = options.recordRetryDelaysInMilliseconds ?? defaultRecordRetryDelays;
  }

  get settings(): ModelUsageCapSettings {
    return this.#settings;
  }

  /**
   * Adds one answer, trying again after each of `recordRetryDelaysInMilliseconds`
   * when the write fails, since it is the only record of what the owner's
   * key spent on it. Never throws, since the answer has been given; usage
   * still not written after the last try is logged as lost, with its counts
   * and whose it was, and nothing of the request or the answer.
   */
  async record(usage: Omit<AnswerUsage, "at">): Promise<void> {
    const at = this.#clock();
    for (const delay of [...this.#recordRetryDelays, undefined]) {
      try {
        await this.#store.add({ ...usage, at });
        return;
      } catch (error) {
        if (delay === undefined) {
          this.#logger.error(
            { err: error, ...usage, at },
            "Could not record a model answer's usage after trying again; it is lost",
          );
          return;
        }
        this.#logger.warn({ err: error, threadId: usage.threadId }, "Recording usage failed");
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async checkCap(ownerUserId: string): Promise<UsageCapCheck> {
    const capTokens = await this.#effectiveCap(ownerUserId);
    if (capTokens === undefined) {
      return { isReached: false };
    }
    const countedTokens = await this.#store.countCappedTokensSince(
      ownerUserId,
      this.#windowStart(),
    );
    return countedTokens < capTokens
      ? { isReached: false }
      : { isReached: true, capTokens, countedTokens, windowHours: this.#settings.windowHours };
  }

  async describeForUser(ownerUserId: string): Promise<UserModelUsageResponse> {
    const recentSince = new Date(this.#clock().getTime() - recentUsageDays * 24 * 60 * 60_000);
    const [ownCapTokens, countedTokensInWindow, byModel] = await Promise.all([
      this.#store.readOwnCap(ownerUserId),
      this.#store.countCappedTokensSince(ownerUserId, this.#windowStart()),
      this.#store.listForUserSince(ownerUserId, recentSince),
    ]);
    return {
      cap: {
        windowHours: this.#settings.windowHours,
        installationCapTokens: this.#settings.installationCapTokens ?? null,
        ownCapTokens: ownCapTokens ?? null,
        countedTokensInWindow,
      },
      recentDays: recentUsageDays,
      byModel,
    };
  }

  listForThread(ownerUserId: string, threadId: string): Promise<ModelUsageTotals[]> {
    return this.#store.listForThread(ownerUserId, threadId);
  }

  /** Sets or removes the user's own cap; one above the installation's is refused, with why. */
  async setOwnCap(
    ownerUserId: string,
    capTokens: number | undefined,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { installationCapTokens } = this.#settings;
    if (
      capTokens !== undefined &&
      installationCapTokens !== undefined &&
      capTokens > installationCapTokens
    ) {
      return {
        ok: false,
        reason: `Your own cap can be at most this installation's, ${installationCapTokens} tokens.`,
      };
    }
    await this.#store.setOwnCap(ownerUserId, capTokens);
    this.#logger.info(
      { ownerUserId, capTokens: capTokens ?? null },
      "A user changed their own model usage cap",
    );
    return { ok: true };
  }

  async #effectiveCap(ownerUserId: string): Promise<number | undefined> {
    const ownCap = await this.#store.readOwnCap(ownerUserId);
    const caps = [this.#settings.installationCapTokens, ownCap].filter((cap) => cap !== undefined);
    return caps.length === 0 ? undefined : Math.min(...caps);
  }

  #windowStart(): Date {
    return new Date(this.#clock().getTime() - this.#settings.windowHours * 60 * 60_000);
  }
}

/** What the user is told when their cap stops a request or a message. */
export function describeReachedCap(check: Extract<UsageCapCheck, { isReached: true }>): string {
  return `You have reached your model usage cap: ${check.countedTokens} of ${check.capTokens} tokens in the last ${check.windowHours} hours. Wait for older usage to leave that window, or raise your own cap in Settings, under Model usage.`;
}
