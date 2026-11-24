import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ModelProxyTokenStore } from "./model-proxy-token-store.js";

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

export class ModelProxyTokens {
  readonly #store: ModelProxyTokenStore;
  readonly #clock: () => Date;

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

  /** Whether `presentedToken` was minted for this thread and provider and not revoked since. */
  async isAccepted(threadId: string, providerId: string, presentedToken: string): Promise<boolean> {
    const presentedDigest = digestToken(presentedToken);
    const storedDigests = await this.#store.listDigests(threadId, providerId);
    const acceptedDigests = storedDigests.length === 0 ? [noAcceptedDigest] : storedDigests;
    // Every digest is compared, in constant time, so the answer's timing
    // says nothing of which, if any, came close.
    let isFound = false;
    for (const digest of acceptedDigests) {
      isFound =
        (digest.length === presentedDigest.length && timingSafeEqual(digest, presentedDigest)) ||
        isFound;
    }
    return isFound;
  }

  revokeThread(threadId: string): Promise<void> {
    return this.#store.revokeThread(threadId);
  }
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
