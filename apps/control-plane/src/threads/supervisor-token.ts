import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Each thread's supervisor proves which thread it serves with a token of its
 * own, minted when the thread is created and handed to the sandbox only
 * through its supervisor's environment. The control plane keeps just the
 * token's digest, so its records do not let anyone connect as a supervisor.
 *
 * A token is 32 random bytes, so guessing one is hopeless and a fast digest
 * is enough; a slow password hash would only slow down every reconnect.
 */
const tokenLengthInBytes = 32;

export type MintedSupervisorToken = {
  /** Goes into the sandbox, and nowhere else: never stored, logged or returned. */
  token: string;
  digest: Buffer;
};

export function mintSupervisorToken(): MintedSupervisorToken {
  const token = randomBytes(tokenLengthInBytes).toString("base64url");
  return { token, digest: digestSupervisorToken(token) };
}

export function digestSupervisorToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * Comparing fixed-length digests in constant time reveals neither the
 * token's length nor how much of a guess was right.
 */
export function supervisorTokenMatches(presentedToken: string, expectedDigest: Buffer): boolean {
  const presentedDigest = digestSupervisorToken(presentedToken);
  return (
    presentedDigest.length === expectedDigest.length &&
    timingSafeEqual(presentedDigest, expectedDigest)
  );
}
