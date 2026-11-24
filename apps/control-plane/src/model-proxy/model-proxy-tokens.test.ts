import { describe, expect, it } from "vitest";
import { ControllableClock } from "../test-support/controllable-clock.js";
import { InMemoryModelProxyTokenStore } from "./in-memory-model-proxy-token-store.js";
import { ModelProxyTokens, recentlyAcceptedForInMilliseconds } from "./model-proxy-tokens.js";

/**
 * A token the database accepted moments ago is accepted again from memory,
 * so a flood of wrong tokens, which must each be looked up, cannot keep an
 * agent that is using its own from being let in; and it stops being so the
 * moment its thread's tokens are revoked or retired here.
 */
async function tokensWithOneMinted() {
  const clock = new ControllableClock();
  const tokens = new ModelProxyTokens(new InMemoryModelProxyTokenStore(), clock.now);
  const token = await tokens.mint("thread-a", "anthropic");
  return { clock, tokens, token };
}

describe("tokens accepted moments ago", () => {
  it("are accepted from memory only once a lookup accepted them, and only for a while", async () => {
    const { clock, tokens, token } = await tokensWithOneMinted();

    expect(tokens.isRecentlyAccepted("thread-a", "anthropic", token)).toBe(false);
    expect(await tokens.isAccepted("thread-a", "anthropic", token)).toBe(true);
    expect(tokens.isRecentlyAccepted("thread-a", "anthropic", token)).toBe(true);
    clock.advanceBy(recentlyAcceptedForInMilliseconds + 1);
    expect(tokens.isRecentlyAccepted("thread-a", "anthropic", token)).toBe(false);
  });

  it("never accept another token, another thread's or another provider's", async () => {
    const { tokens, token } = await tokensWithOneMinted();
    await tokens.isAccepted("thread-a", "anthropic", token);

    expect(tokens.isRecentlyAccepted("thread-a", "anthropic", "B".repeat(43))).toBe(false);
    expect(tokens.isRecentlyAccepted("thread-b", "anthropic", token)).toBe(false);
    expect(tokens.isRecentlyAccepted("thread-a", "openai", token)).toBe(false);
  });

  it("are forgotten when the thread's tokens are revoked, or its provider's retired", async () => {
    const { tokens, token } = await tokensWithOneMinted();
    await tokens.isAccepted("thread-a", "anthropic", token);
    await tokens.revokeThread("thread-a");
    expect(tokens.isRecentlyAccepted("thread-a", "anthropic", token)).toBe(false);

    const retired = await tokens.mint("thread-a", "anthropic");
    await tokens.isAccepted("thread-a", "anthropic", retired);
    await tokens.retainProviders("thread-a", ["openai"]);
    expect(tokens.isRecentlyAccepted("thread-a", "anthropic", retired)).toBe(false);
  });

  it("are not remembered by a lookup that finished after the thread's tokens were revoked", async () => {
    const { tokens, token } = await tokensWithOneMinted();

    const lookup = tokens.isAccepted("thread-a", "anthropic", token);
    const revocation = tokens.revokeThread("thread-a");
    await Promise.all([lookup, revocation]);

    expect(tokens.isRecentlyAccepted("thread-a", "anthropic", token)).toBe(false);
  });
});
