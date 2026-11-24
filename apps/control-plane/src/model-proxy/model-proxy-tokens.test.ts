import { describe, expect, it } from "vitest";
import { ControllableClock } from "../test-support/controllable-clock.js";
import { InMemoryModelProxyTokenStore } from "./in-memory-model-proxy-token-store.js";
import { ModelProxyTokens, recentlyAcceptedForInMilliseconds } from "./model-proxy-tokens.js";

const halfTheirTime = recentlyAcceptedForInMilliseconds / 2;

/**
 * A token the database accepted moments ago is accepted again from memory,
 * so a flood of wrong tokens, which must each be looked up, cannot keep an
 * agent that is using its own from being let in, however long it works:
 * past half its time, the next request has it looked up again, and
 * remembered afresh or forgotten. It stops being so the moment its
 * thread's tokens are revoked or retired here, including by a lookup that
 * raced the revocation.
 */
async function tokensWithOneMinted(store = new InMemoryModelProxyTokenStore()) {
  const clock = new ControllableClock();
  const tokens = new ModelProxyTokens(store, clock.now);
  const token = await tokens.mint("thread-a", "anthropic");
  return { clock, tokens, token, store };
}

/** A store whose revocations take as long as a database's write would. */
class SlowRevocationStore extends InMemoryModelProxyTokenStore {
  override async revokeThread(threadId: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return super.revokeThread(threadId);
  }

  override async retainProviders(threadId: string, keptProviderIds: readonly string[]) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return super.retainProviders(threadId, keptProviderIds);
  }
}

describe("tokens accepted moments ago", () => {
  it("are accepted from memory only once a lookup accepted them, and only for a while", async () => {
    const { clock, tokens, token } = await tokensWithOneMinted();

    expect(tokens.recallAcceptance("thread-a", "anthropic", token)).toBe("not_remembered");
    expect(await tokens.isAccepted("thread-a", "anthropic", token)).toBe(true);
    expect(tokens.recallAcceptance("thread-a", "anthropic", token)).toBe("fresh");
    clock.advanceBy(recentlyAcceptedForInMilliseconds + 1);
    expect(tokens.recallAcceptance("thread-a", "anthropic", token)).toBe("not_remembered");
  });

  it("never accept another token, another thread's or another provider's", async () => {
    const { tokens, token } = await tokensWithOneMinted();
    await tokens.isAccepted("thread-a", "anthropic", token);

    expect(tokens.recallAcceptance("thread-a", "anthropic", "B".repeat(43))).toBe("not_remembered");
    expect(tokens.recallAcceptance("thread-b", "anthropic", token)).toBe("not_remembered");
    expect(tokens.recallAcceptance("thread-a", "openai", token)).toBe("not_remembered");
  });

  it("are forgotten when the thread's tokens are revoked, or its provider's retired", async () => {
    const { tokens, token } = await tokensWithOneMinted();
    await tokens.isAccepted("thread-a", "anthropic", token);
    await tokens.revokeThread("thread-a");
    expect(tokens.recallAcceptance("thread-a", "anthropic", token)).toBe("not_remembered");

    const retired = await tokens.mint("thread-a", "anthropic");
    await tokens.isAccepted("thread-a", "anthropic", retired);
    await tokens.retainProviders("thread-a", ["openai"]);
    expect(tokens.recallAcceptance("thread-a", "anthropic", retired)).toBe("not_remembered");
  });

  it("are not remembered by a lookup that finished after the thread's tokens were revoked", async () => {
    const { tokens, token } = await tokensWithOneMinted();

    const lookup = tokens.isAccepted("thread-a", "anthropic", token);
    const revocation = tokens.revokeThread("thread-a");
    await Promise.all([lookup, revocation]);

    expect(tokens.recallAcceptance("thread-a", "anthropic", token)).toBe("not_remembered");
  });

  it("are due to be looked up again after half their time, and renewed by a lookup that accepts them", async () => {
    const { clock, tokens, token } = await tokensWithOneMinted();
    await tokens.isAccepted("thread-a", "anthropic", token);

    clock.advanceBy(halfTheirTime + 1);
    expect(tokens.recallAcceptance("thread-a", "anthropic", token)).toBe("due_for_renewal");
    expect(await tokens.isAccepted("thread-a", "anthropic", token)).toBe(true);
    clock.advanceBy(halfTheirTime);
    expect(tokens.recallAcceptance("thread-a", "anthropic", token)).toBe("fresh");
  });

  it("are forgotten once a lookup no longer accepts them, as when another instance revoked them", async () => {
    const { tokens, token, store } = await tokensWithOneMinted();
    await tokens.isAccepted("thread-a", "anthropic", token);
    await store.revokeThread("thread-a");

    expect(await tokens.isAccepted("thread-a", "anthropic", token)).toBe(false);
    expect(tokens.recallAcceptance("thread-a", "anthropic", token)).toBe("not_remembered");
  });

  it("are not remembered by a lookup made while their revocation is being written", async () => {
    const { tokens, token } = await tokensWithOneMinted(new SlowRevocationStore());

    const revocation = tokens.revokeThread("thread-a");
    const acceptedMeanwhile = await tokens.isAccepted("thread-a", "anthropic", token);
    await revocation;

    expect(acceptedMeanwhile).toBe(true);
    expect(tokens.recallAcceptance("thread-a", "anthropic", token)).toBe("not_remembered");
  });

  it("are not remembered by a lookup made while their provider's retirement is being written", async () => {
    const { tokens, token } = await tokensWithOneMinted(new SlowRevocationStore());

    const retirement = tokens.retainProviders("thread-a", ["openai"]);
    await tokens.isAccepted("thread-a", "anthropic", token);
    await retirement;

    expect(tokens.recallAcceptance("thread-a", "anthropic", token)).toBe("not_remembered");
  });
});
