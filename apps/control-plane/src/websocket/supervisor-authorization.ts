import { bearerTokenFrom } from "../bearer-token.js";
import { supervisorTokenMatches } from "../threads/supervisor-token.js";
import type { ThreadStore } from "../threads/thread-store.js";

export type SupervisorCredentials = {
  threadId: string;
  /** The upgrade request's `Authorization` header, if it had one. */
  authorizationHeader: string | undefined;
};

/**
 * Decides whether a supervisor may connect for the thread it names. Rejects
 * when the decision cannot be made (the thread store is unreachable), which
 * is not the same as refusing.
 */
export type SupervisorAuthorization = (credentials: SupervisorCredentials) => Promise<boolean>;

/**
 * A supervisor may connect only with a token minted for the thread it
 * names (see `ThreadRecord.supervisorTokenDigests`), so a sandbox holding one thread's token cannot pass itself off as
 * another thread's supervisor. A thread that does not exist is refused the
 * same way as a wrong token, so the answer does not say which it was.
 */
export function authorizeWithThreadTokens(threadStore: ThreadStore): SupervisorAuthorization {
  return async ({ threadId, authorizationHeader }) => {
    const presentedToken = bearerTokenFrom(authorizationHeader);
    if (presentedToken === undefined) {
      return false;
    }
    const thread = await threadStore.find(threadId);
    const acceptedDigests = thread?.supervisorTokenDigests ?? [];
    return acceptedDigests.some((digest) => supervisorTokenMatches(presentedToken, digest));
  };
}
