import { describe, expect, it } from "vitest";
import type { ModelProxyTokenStore } from "../model-proxy/model-proxy-token-store.js";
import type { AnswerUsage, ModelUsageStore } from "../model-usage/model-usage-store.js";

/**
 * What every model proxy token store and usage store must do, held to the
 * same tests in memory and in Postgres. Each store is given two handles on
 * the same data where the backend allows it, standing in for two control
 * plane instances.
 */

/** The threads and owners a contract's stores must already know (Postgres's references need them). */
export const contractThreadIds = ["thread-a", "thread-b"];
export const contractOwnerUserIds = ["user-a", "user-b"];

export function describeModelProxyTokenStoreContract(
  implementationName: string,
  createStores: () => Promise<[ModelProxyTokenStore, ModelProxyTokenStore]>,
): void {
  describe(`${implementationName} as a model proxy token store`, () => {
    const digest = (fill: number) => Buffer.alloc(32, fill);
    const at = (second: number) => new Date(Date.UTC(2026, 10, 24, 12, 0, second));

    it("accepts a token minted on one instance at the other, for its thread and provider only", async () => {
      const [first, second] = await createStores();

      await first.accept({
        threadId: "thread-a",
        providerId: "anthropic",
        digest: digest(1),
        mintedAt: at(0),
      });

      expect(await second.listDigests("thread-a", "anthropic")).toEqual([digest(1)]);
      expect(await second.listDigests("thread-a", "openai")).toEqual([]);
      expect(await second.listDigests("thread-b", "anthropic")).toEqual([]);
    });

    it("keeps the newest four per thread and provider", async () => {
      const [store] = await createStores();

      for (let second = 1; second <= 6; second += 1) {
        await store.accept({
          threadId: "thread-a",
          providerId: "anthropic",
          digest: digest(second),
          mintedAt: at(second),
        });
      }

      const kept = await store.listDigests("thread-a", "anthropic");
      expect(kept.map((kept) => kept[0]).sort()).toEqual([3, 4, 5, 6]);
    });

    it("revokes every token of a thread, and only that thread's", async () => {
      const [first, second] = await createStores();
      await first.accept({
        threadId: "thread-a",
        providerId: "anthropic",
        digest: digest(1),
        mintedAt: at(0),
      });
      await first.accept({
        threadId: "thread-a",
        providerId: "openai",
        digest: digest(2),
        mintedAt: at(0),
      });
      await first.accept({
        threadId: "thread-b",
        providerId: "anthropic",
        digest: digest(3),
        mintedAt: at(0),
      });

      await second.revokeThread("thread-a");

      expect(await first.listDigests("thread-a", "anthropic")).toEqual([]);
      expect(await first.listDigests("thread-a", "openai")).toEqual([]);
      expect(await first.listDigests("thread-b", "anthropic")).toEqual([digest(3)]);
    });
  });
}

export function describeModelUsageStoreContract(
  implementationName: string,
  createStores: () => Promise<[ModelUsageStore, ModelUsageStore]>,
): void {
  describe(`${implementationName} as a model usage store`, () => {
    const answer = (overrides: Partial<AnswerUsage> = {}): AnswerUsage => ({
      ownerUserId: "user-a",
      threadId: "thread-a",
      providerId: "anthropic",
      modelId: "claude-x",
      source: "measured",
      at: new Date(Date.UTC(2026, 10, 24, 12, 30)),
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 50,
      ...overrides,
    });

    it("adds up every answer counted at once, on either instance, in one row per hour", async () => {
      const [first, second] = await createStores();

      await Promise.all(
        Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? first : second).add(answer())),
      );

      expect(await first.listForThread("user-a", "thread-a")).toEqual([
        {
          providerId: "anthropic",
          modelId: "claude-x",
          source: "measured",
          inputTokens: 2_000,
          outputTokens: 200,
          cacheReadTokens: 20_000,
          cacheWriteTokens: 1_000,
          answerCount: 20,
        },
      ]);
    });

    it("counts towards the cap only what the proxy counted, within the window", async () => {
      const [store] = await createStores();
      await store.add(answer());
      await store.add(
        answer({
          source: "estimated",
          inputTokens: 5,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      );
      await store.add(answer({ source: "reported", providerId: "google", inputTokens: 999_999 }));
      await store.add(answer({ at: new Date(Date.UTC(2026, 10, 22, 12)) }));
      await store.add(answer({ ownerUserId: "user-b" }));

      expect(
        await store.countCappedTokensSince("user-a", new Date(Date.UTC(2026, 10, 24, 0))),
      ).toBe(1_160 + 10);
    });

    it("lists a user's recent usage by model and source, and a thread's all-time", async () => {
      const [store] = await createStores();
      await store.add(answer());
      await store.add(
        answer({
          threadId: "thread-b",
          source: "reported",
          providerId: "google",
          modelId: "gemini-x",
        }),
      );
      await store.add(answer({ at: new Date(Date.UTC(2026, 9, 1)) }));

      const recent = await store.listForUserSince("user-a", new Date(Date.UTC(2026, 10, 20)));
      const threadA = await store.listForThread("user-a", "thread-a");

      expect(recent.map((total) => [total.providerId, total.source, total.answerCount])).toEqual([
        ["anthropic", "measured", 1],
        ["google", "reported", 1],
      ]);
      expect(threadA).toEqual([expect.objectContaining({ answerCount: 2 })]);
      expect(await store.listForThread("user-b", "thread-a")).toEqual([]);
    });

    it("keeps the cap a user set on themselves until they remove it", async () => {
      const [first, second] = await createStores();

      expect(await first.readOwnCap("user-a")).toBeUndefined();
      await first.setOwnCap("user-a", 5_000);
      expect(await second.readOwnCap("user-a")).toBe(5_000);
      await second.setOwnCap("user-a", 7_000);
      expect(await first.readOwnCap("user-a")).toBe(7_000);
      await first.setOwnCap("user-a", undefined);
      expect(await second.readOwnCap("user-a")).toBeUndefined();
    });
  });
}
