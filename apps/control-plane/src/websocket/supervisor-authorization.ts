import { createHash, timingSafeEqual } from "node:crypto";

export type SupervisorCredentials = {
  threadId: string;
  /** The upgrade request's `Authorization` header, if it had one. */
  authorizationHeader: string | undefined;
};

/** Decides whether a supervisor may connect for the thread it names. */
export type SupervisorAuthorization = (credentials: SupervisorCredentials) => boolean;

/**
 * Milestone 1 has one token shared by every supervisor, so the thread is not
 * consulted yet. Per-thread tokens, which stop one sandbox from impersonating
 * another, replace this when real sandboxes arrive; callers already pass the
 * thread for that reason.
 */
export function authorizeWithSharedToken(sharedToken: string): SupervisorAuthorization {
  const expectedTokenDigest = digestOf(sharedToken);
  return ({ authorizationHeader }) => {
    const presentedToken = bearerTokenFrom(authorizationHeader);
    if (presentedToken === undefined) {
      return false;
    }
    // Comparing fixed-length digests in constant time reveals neither the
    // token's length nor how much of a guess was right.
    return timingSafeEqual(digestOf(presentedToken), expectedTokenDigest);
  };
}

/** https://www.rfc-editor.org/rfc/rfc6750#section-2.1 (the scheme name is case-insensitive). */
function bearerTokenFrom(authorizationHeader: string | undefined): string | undefined {
  const match = /^Bearer +(\S+)\s*$/i.exec(authorizationHeader ?? "");
  return match?.[1];
}

function digestOf(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
