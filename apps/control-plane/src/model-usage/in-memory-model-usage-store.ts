import { countTokens, type ModelUsageTotals } from "@barrack/protocol";
import {
  type AnswerUsage,
  compareTotals,
  hourOf,
  type ModelUsageStore,
} from "./model-usage-store.js";

type HourRow = Omit<AnswerUsage, "at"> & { hour: Date; answerCount: number };

/** Usage in memory, for development and tests. Lost on restart. */
export class InMemoryModelUsageStore implements ModelUsageStore {
  readonly #rows = new Map<string, HourRow>();
  readonly #ownCaps = new Map<string, number>();

  async add(usage: AnswerUsage): Promise<void> {
    const hour = hourOf(usage.at);
    const key = JSON.stringify([
      usage.ownerUserId,
      usage.threadId,
      usage.providerId,
      usage.modelId,
      usage.source,
      hour.getTime(),
    ]);
    const row = this.#rows.get(key) ?? {
      ...usage,
      hour,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      answerCount: 0,
    };
    row.inputTokens += usage.inputTokens;
    row.outputTokens += usage.outputTokens;
    row.cacheReadTokens += usage.cacheReadTokens;
    row.cacheWriteTokens += usage.cacheWriteTokens;
    row.answerCount += 1;
    this.#rows.set(key, row);
  }

  async countCappedTokensSince(ownerUserId: string, since: Date): Promise<number> {
    return this.#rowsOf(ownerUserId, since)
      .filter((row) => row.source !== "reported")
      .reduce((count, row) => count + countTokens(row), 0);
  }

  async listForUserSince(ownerUserId: string, since: Date): Promise<ModelUsageTotals[]> {
    return addUp(this.#rowsOf(ownerUserId, since));
  }

  async listForThread(ownerUserId: string, threadId: string): Promise<ModelUsageTotals[]> {
    return addUp(this.#rowsOf(ownerUserId, new Date(0)).filter((row) => row.threadId === threadId));
  }

  async readOwnCap(ownerUserId: string): Promise<number | undefined> {
    return this.#ownCaps.get(ownerUserId);
  }

  async setOwnCap(ownerUserId: string, capTokens: number | undefined): Promise<void> {
    if (capTokens === undefined) {
      this.#ownCaps.delete(ownerUserId);
    } else {
      this.#ownCaps.set(ownerUserId, capTokens);
    }
  }

  /** Hours that end after `since` count, as the Postgres store's do. */
  #rowsOf(ownerUserId: string, since: Date): HourRow[] {
    const firstHour = hourOf(since).getTime();
    return [...this.#rows.values()].filter(
      (row) => row.ownerUserId === ownerUserId && row.hour.getTime() >= firstHour,
    );
  }
}

function addUp(rows: HourRow[]): ModelUsageTotals[] {
  const totals = new Map<string, ModelUsageTotals>();
  for (const row of rows) {
    const key = JSON.stringify([row.providerId, row.modelId, row.source]);
    const total = totals.get(key) ?? {
      providerId: row.providerId,
      modelId: row.modelId,
      source: row.source,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      answerCount: 0,
    };
    total.inputTokens += row.inputTokens;
    total.outputTokens += row.outputTokens;
    total.cacheReadTokens += row.cacheReadTokens;
    total.cacheWriteTokens += row.cacheWriteTokens;
    total.answerCount += row.answerCount;
    totals.set(key, total);
  }
  return [...totals.values()].sort(compareTotals);
}
