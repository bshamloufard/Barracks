import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { keptPerProvider, type ModelProxyTokenStore } from "./model-proxy-token-store.js";

/**
 * What a thread's agent holds in place of its owner's key, for a provider
 * whose traffic the control plane relays: 32 random bytes, minted for one
 * supervisor connection and one provider, of which only the SHA-256 digest
 * is kept. A token is accepted only at the model proxy, only in a request
 * naming its own thread and provider, and only while that thread may run
 * (see `ModelProxyAuthorization`); a thread's are all revoked when its
 * sandbox begins stopping or the thread is deleted.
 */
const tokenLengthInBytes = 32;

/** What every minted token looks like: 32 bytes in base64url, without padding. */
const wellFormedToken = /^[A-Za-z0-9_-]{43}$/;

/**
 * Compared with a presented token when the thread and provider have none,
 * so the answer takes as long for a thread that does not exist as for a
 * wrong token; nothing hashes to it.
 */
const noAcceptedDigest = Buffer.alloc(32);

/**
 * How long a token a lookup accepted stays remembered by this instance
 * after it was last used here: looked up, let in, or at the end of a
 * request it was let in for. An agent at work, whose next request follows
 * within seconds of the last one ending, so stays remembered however long
 * it works.
 */
export const recentlyAcceptedForInMilliseconds = 30_000;

/**
 * How long after its last lookup a remembered token is let in from memory
 * alone. Past that, the next request presenting it has it looked up again
 * (outside the instance's bound on lookups, since only a caller holding a
 * remembered token gets there), and remembered afresh or forgotten by the
 * answer: so a token revoked by the other instance during a redeploy's
 * overlap is let in here at most this long after its last lookup, and every
 * request is checked against the records anyway.
 */
const renewedAfterInMilliseconds = 15_000;

/**
 * What this instance remembers of a token: looked up lately (`fresh`),
 * remembered but last looked up long enough ago that it is to be looked up
 * again (`due_for_renewal`), or nothing (`not_remembered`), when it must be
 * looked up within the bound strangers share.
 */
export type RememberedAcceptance = "fresh" | "due_for_renewal" | "not_remembered";

/** Beyond this many threads and providers remembered, the longest unused is forgotten. */
const maximumRemembered = 10_000;

type RememberedDigest = { digest: Buffer; lookedUpAt: number; usedAt: number };

/** A lookup under way, marked when a revocation of its thread begins or ends meanwhile. */
type LookupUnderWay = { overlapsRevocation: boolean };

export class ModelProxyTokens {
  readonly #store: ModelProxyTokenStore;
  readonly #clock: () => Date;
  /** Digests accepted lately, by thread and provider, newest last. */
  readonly #recentlyAccepted = new Map<string, RememberedDigest[]>();
  /**
   * The lookups under way, by thread, so a revocation of a thread on this
   * instance keeps a lookup of its tokens under way then from being
   * remembered, and no other thread's.
   */
  readonly #lookupsUnderWay = new Map<string, Set<LookupUnderWay>>();

  constructor(store: ModelProxyTokenStore, clock: () => Date = () => new Date()) {
    this.#store = store;
    this.#clock = clock;
  }

  /** A new token for the thread and provider, accepted from now on. Never stored, logged or returned to a user. */
  async mint(threadId: string, providerId: string): Promise<string> {
    const token = randomBytes(tokenLengthInBytes).toString("base64url");
    await this.#store.accept({
      threadId,
      providerId,
      digest: digestToken(token),
      mintedAt: this.#clock(),
    });
    return token;
  }

  /**
   * Whether `presentedToken` could be a token at all; one that could not is
   * refused without asking the store.
   */
  static isWellFormed(presentedToken: string): boolean {
    return wellFormedToken.test(presentedToken);
  }

  /**
   * Whether `presentedToken` was minted for this thread and provider and not
   * revoked since, as the store says. One it accepts is remembered for
   * `recallAcceptance`, unless a revocation of its thread on this instance began or ended
   * while it was looked up; one it refuses is forgotten.
   */
  async isAccepted(threadId: string, providerId: string, presentedToken: string): Promise<boolean> {
    const presentedDigest = digestToken(presentedToken);
    const lookup: LookupUnderWay = { overlapsRevocation: false };
    const lookups = this.#lookupsUnderWay.get(threadId) ?? new Set();
    this.#lookupsUnderWay.set(threadId, lookups.add(lookup));
    let storedDigests: Buffer[];
    try {
      storedDigests = await this.#store.listDigests(threadId, providerId);
    } finally {
      lookups.delete(lookup);
      if (lookups.size === 0 && this.#lookupsUnderWay.get(threadId) === lookups) {
        this.#lookupsUnderWay.delete(threadId);
      }
    }
    const isFound = isAmong(presentedDigest, storedDigests);
    if (!isFound) {
      this.#forgetDigest(threadId, providerId, presentedDigest);
    } else if (!lookup.overlapsRevocation) {
      this.#remember(threadId, providerId, presentedDigest);
    }
    return isFound;
  }

  /**
   * What this instance remembers of `presentedToken` for this thread and
   * provider, from memory alone; a `fresh` one is noted as used now. The
   * same work is done whatever is remembered, and a token not remembered
   * is simply looked up, so this tells a caller nothing about anyone
   * else's token.
   */
  recallAcceptance(
    threadId: string,
    providerId: string,
    presentedToken: string,
  ): RememberedAcceptance {
    const now = this.#clock().getTime();
    const remembered = this.#findRemembered(threadId, providerId, now);
    const presentedDigest = digestToken(presentedToken);
    let matched: RememberedDigest | undefined;
    for (let slot = 0; slot < keptPerProvider; slot += 1) {
      const entry = remembered[slot];
      if (isAmong(presentedDigest, [entry?.digest ?? noAcceptedDigest])) {
        matched = entry;
      }
    }
    if (matched === undefined) {
      return "not_remembered";
    }
    if (now - matched.lookedUpAt > renewedAfterInMilliseconds) {
      return "due_for_renewal";
    }
    matched.usedAt = now;
    return "fresh";
  }

  /**
   * Notes that a request let in with `presentedToken` has just ended, so an
   * agent whose next request follows soon after is still remembered,
   * however long the request lasted. A token forgotten meanwhile, revoked
   * or refused by a lookup, stays forgotten; and one remembered still is
   * looked up again on its next request if its last lookup was long ago.
   */
  noteUsed(threadId: string, providerId: string, presentedToken: string): void {
    const presentedDigest = digestToken(presentedToken);
    const matched = this.#recentlyAccepted
      .get(rememberedKey(threadId, providerId))
      ?.find((entry) => entry.digest.equals(presentedDigest));
    if (matched !== undefined) {
      matched.usedAt = this.#clock().getTime();
    }
  }

  /**
   * Revokes every token of the thread's. What is remembered of them is
   * forgotten both before and after the store's revocation is written, so
   * a lookup that read the store before the write landed is forgotten too.
   */
  async revokeThread(threadId: string): Promise<void> {
    this.#forget(threadId, () => true);
    try {
      await this.#store.revokeThread(threadId);
    } finally {
      this.#forget(threadId, () => true);
    }
  }

  /** Retires the thread's tokens for every provider but these, forgetting them as `revokeThread` does. */
  async retainProviders(threadId: string, keptProviderIds: readonly string[]): Promise<void> {
    const isRetired = (providerId: string) => !keptProviderIds.includes(providerId);
    this.#forget(threadId, isRetired);
    try {
      await this.#store.retainProviders(threadId, keptProviderIds);
    } finally {
      this.#forget(threadId, isRetired);
    }
  }

  #remember(threadId: string, providerId: string, digest: Buffer): void {
    const key = rememberedKey(threadId, providerId);
    const entries = (this.#recentlyAccepted.get(key) ?? []).filter(
      (entry) => !entry.digest.equals(digest),
    );
    const now = this.#clock().getTime();
    entries.push({ digest, lookedUpAt: now, usedAt: now });
    // Re-inserted, so the map's order is from longest unused to latest.
    this.#recentlyAccepted.delete(key);
    this.#recentlyAccepted.set(key, entries.slice(-keptPerProvider));
    for (const oldest of this.#recentlyAccepted.keys()) {
      if (this.#recentlyAccepted.size <= maximumRemembered) {
        break;
      }
      this.#recentlyAccepted.delete(oldest);
    }
  }

  /** The thread's and provider's digests used here lately enough to be remembered still. */
  #findRemembered(threadId: string, providerId: string, now: number): RememberedDigest[] {
    return (this.#recentlyAccepted.get(rememberedKey(threadId, providerId)) ?? [])
      .filter((entry) => entry.usedAt >= now - recentlyAcceptedForInMilliseconds)
      .slice(-keptPerProvider);
  }

  #forgetDigest(threadId: string, providerId: string, digest: Buffer): void {
    const key = rememberedKey(threadId, providerId);
    const kept = (this.#recentlyAccepted.get(key) ?? []).filter(
      (entry) => !entry.digest.equals(digest),
    );
    if (kept.length === 0) {
      this.#recentlyAccepted.delete(key);
    } else {
      this.#recentlyAccepted.set(key, kept);
    }
  }

  #forget(threadId: string, isForgotten: (providerId: string) => boolean): void {
    for (const lookup of this.#lookupsUnderWay.get(threadId) ?? []) {
      lookup.overlapsRevocation = true;
    }
    for (const key of this.#recentlyAccepted.keys()) {
      const [keyThreadId, providerId] = key.split("\n");
      if (keyThreadId === threadId && isForgotten(providerId ?? "")) {
        this.#recentlyAccepted.delete(key);
      }
    }
  }
}

/**
 * Every digest is compared, in constant time, so the answer's timing says
 * nothing of which, if any, came close.
 */
function isAmong(presentedDigest: Buffer, digests: readonly Buffer[]): boolean {
  const candidates = digests.length === 0 ? [noAcceptedDigest] : digests;
  let isFound = false;
  for (const digest of candidates) {
    isFound =
      (digest.length === presentedDigest.length && timingSafeEqual(digest, presentedDigest)) ||
      isFound;
  }
  return isFound;
}

function rememberedKey(threadId: string, providerId: string): string {
  return `${threadId}\n${providerId}`;
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
