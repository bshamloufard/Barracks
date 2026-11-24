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
 * How long a token a lookup accepted is accepted again from memory, by
 * this instance, without another lookup. Long enough that an agent at
 * work, whose requests come seconds apart, is looked up about twice a
 * minute; short enough that a token revoked by the other instance during
 * a redeploy's overlap is not accepted here for long, and every request
 * is checked against the records anyway.
 */
export const recentlyAcceptedForInMilliseconds = 30_000;

/** Beyond this many threads and providers remembered, the longest unused is forgotten. */
const maximumRemembered = 10_000;

type RememberedDigest = { digest: Buffer; acceptedAt: number };

export class ModelProxyTokens {
  readonly #store: ModelProxyTokenStore;
  readonly #clock: () => Date;
  /** Digests accepted lately, by thread and provider, newest last. */
  readonly #recentlyAccepted = new Map<string, RememberedDigest[]>();
  /** Moves on with each revocation on this instance, so a lookup under way then is not remembered. */
  #revocations = 0;

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
   * revoked since, as the store says; one it accepts is remembered for
   * `isRecentlyAccepted`.
   */
  async isAccepted(threadId: string, providerId: string, presentedToken: string): Promise<boolean> {
    const presentedDigest = digestToken(presentedToken);
    const revocationsBefore = this.#revocations;
    const storedDigests = await this.#store.listDigests(threadId, providerId);
    const isFound = isAmong(presentedDigest, storedDigests);
    if (isFound && this.#revocations === revocationsBefore) {
      this.#remember(threadId, providerId, presentedDigest);
    }
    return isFound;
  }

  /**
   * Whether a lookup accepted `presentedToken` for this thread and provider
   * in the last `recentlyAcceptedForInMilliseconds`, from memory alone.
   * The same work is done whatever is remembered, and a token not
   * remembered is simply looked up, so this tells a caller nothing.
   */
  isRecentlyAccepted(threadId: string, providerId: string, presentedToken: string): boolean {
    const notBefore = this.#clock().getTime() - recentlyAcceptedForInMilliseconds;
    const remembered = (this.#recentlyAccepted.get(rememberedKey(threadId, providerId)) ?? [])
      .filter((entry) => entry.acceptedAt >= notBefore)
      .map((entry) => entry.digest);
    const slots = [...remembered, ...Array(keptPerProvider).fill(noAcceptedDigest)].slice(
      0,
      keptPerProvider,
    );
    return isAmong(digestToken(presentedToken), slots);
  }

  revokeThread(threadId: string): Promise<void> {
    this.#forget(threadId, () => true);
    return this.#store.revokeThread(threadId);
  }

  /** Retires the thread's tokens for every provider but these. */
  retainProviders(threadId: string, keptProviderIds: readonly string[]): Promise<void> {
    this.#forget(threadId, (providerId) => !keptProviderIds.includes(providerId));
    return this.#store.retainProviders(threadId, keptProviderIds);
  }

  #remember(threadId: string, providerId: string, digest: Buffer): void {
    const key = rememberedKey(threadId, providerId);
    const entries = (this.#recentlyAccepted.get(key) ?? []).filter(
      (entry) => !entry.digest.equals(digest),
    );
    entries.push({ digest, acceptedAt: this.#clock().getTime() });
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

  #forget(threadId: string, isForgotten: (providerId: string) => boolean): void {
    this.#revocations += 1;
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
