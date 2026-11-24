import pino from "pino";
import { describe, expect, it } from "vitest";
import { InMemoryModelUsageStore } from "./in-memory-model-usage-store.js";
import { ModelUsage } from "./model-usage.js";
import type { AnswerUsage } from "./model-usage-store.js";

/**
 * Recording an answer's usage, which is the only record of what the owner's
 * key spent on it: a write that fails is tried again a few times, and one
 * still lost is logged, without any content, so an operator can see what
 * went uncounted.
 */

class StoreFailingWrites extends InMemoryModelUsageStore {
  #failuresLeft: number;

  constructor(failures: number) {
    super();
    this.#failuresLeft = failures;
  }

  override async add(usage: AnswerUsage): Promise<void> {
    if (this.#failuresLeft > 0) {
      this.#failuresLeft -= 1;
      throw new Error("The database did not answer in time.");
    }
    await super.add(usage);
  }
}

const answer = {
  ownerUserId: "user-a",
  threadId: "thread-a",
  providerId: "anthropic",
  modelId: "a-model",
  source: "estimated" as const,
  inputTokens: 1_200,
  outputTokens: 64_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function usageWith(store: InMemoryModelUsageStore) {
  const logLines: string[] = [];
  const usage = new ModelUsage({
    store,
    settings: { installationCapTokens: undefined, windowHours: 24 },
    logger: pino({ level: "trace" }, { write: (line: string) => logLines.push(line) }),
    recordRetryDelaysInMilliseconds: [0, 0],
  });
  return { usage, logLines };
}

describe("recording an answer's usage", () => {
  it("tries a failed write again, and counts the answer once", async () => {
    const store = new StoreFailingWrites(2);
    const { usage } = usageWith(store);

    await usage.record(answer);

    expect(await store.listForThread("user-a", "thread-a")).toEqual([
      expect.objectContaining({ outputTokens: 64_000, answerCount: 1 }),
    ]);
  });

  it("says what was lost, and no more, once every try has failed", async () => {
    const store = new StoreFailingWrites(3);
    const { usage, logLines } = usageWith(store);

    await usage.record(answer);

    expect(await store.listForThread("user-a", "thread-a")).toEqual([]);
    const lost = logLines.map((line) => JSON.parse(line)).find((line) => line.level === 50);
    expect(lost).toMatchObject({
      threadId: "thread-a",
      providerId: "anthropic",
      source: "estimated",
      inputTokens: 1_200,
      outputTokens: 64_000,
      msg: expect.stringContaining("lost"),
    });
  });
});
