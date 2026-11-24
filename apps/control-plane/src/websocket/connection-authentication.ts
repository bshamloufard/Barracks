import { closeCodes } from "@barrack/protocol";
import type {
  AuthenticatedUser,
  AuthenticationRefusal,
  Authenticator,
} from "../authentication/authenticator.js";
import type { Logger } from "../logger.js";
import { standardCloseCodes } from "../standard-close-codes.js";
import { SerialTaskQueue } from "../thread-relay/serial-task-queue.js";
import { ThreadAccess } from "../threads/thread-access.js";
import type { ThreadStore } from "../threads/thread-store.js";

export type AuthenticatedOwner = { access: ThreadAccess; user: AuthenticatedUser };

export type ConnectionAuthenticationOptions = {
  authenticator: Authenticator;
  threadStore: ThreadStore;
  logger: Logger;
  /** Closes the connection; close reasons must fit in 123 bytes, so they stay short. */
  close: (closeCode: number, reason: string) => void;
};

/** setTimeout fires at once for longer delays, so a far-off expiry is reached in steps. */
const longestTimerDelayInMilliseconds = 2 ** 31 - 1;

/**
 * Who is at the other end of a user's WebSocket (a thread's client, or a
 * desktop viewer), the same way for each: the first token must be valid and
 * its user must own the thread (another user's thread is answered exactly as
 * a missing one, `threadNotFound`); every later token must be for the same
 * user; and when the newest expires without a replacement, the connection
 * is closed with `accessTokenExpired`. Every refusal closes the connection
 * with the code that tells the client what to do.
 */
export class ConnectionAuthentication {
  readonly #options: ConnectionAuthenticationOptions;
  /** Later tokens are checked one at a time, so the newest one sent is the one that counts. */
  readonly #refreshes = new SerialTaskQueue();
  #userId: string | undefined;
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  #isDisposed = false;

  constructor(options: ConnectionAuthenticationOptions) {
    this.#options = options;
  }

  /** Resolves with the owner, or undefined having closed the connection saying why. */
  async authenticateOwner(
    accessToken: string,
    threadId: string,
  ): Promise<AuthenticatedOwner | undefined> {
    const { authenticator, threadStore, logger } = this.#options;
    const outcome = await authenticator.authenticate(accessToken);
    if (!outcome.ok) {
      this.#refuse(outcome.refusal);
      return undefined;
    }
    let access: ThreadAccess | undefined;
    try {
      access = await ThreadAccess.check(threadStore, outcome.user.userId, threadId);
    } catch (error) {
      logger.error({ err: error }, "Could not look up the thread a client asked for");
      this.#options.close(
        standardCloseCodes.tryAgainLater,
        "Could not look up the thread; try again",
      );
      return undefined;
    }
    if (access === undefined) {
      logger.warn(
        { userId: outcome.user.userId },
        "Refused a client a thread that does not exist or is not its user's",
      );
      this.#options.close(closeCodes.threadNotFound, "There is no such thread");
      return undefined;
    }
    this.#userId = outcome.user.userId;
    this.#closeWhenExpired(outcome.user.validUntil);
    return { access, user: outcome.user };
  }

  /** A newer token, sent on the open connection once the owner was authenticated. */
  acceptRefreshedToken(accessToken: string): void {
    const userId = this.#userId;
    if (userId === undefined) {
      return;
    }
    void this.#refreshes.enqueue(() => this.#reauthenticate(userId, accessToken));
  }

  /** Stops watching for expiry, once the connection has closed. */
  dispose(): void {
    this.#isDisposed = true;
    clearTimeout(this.#expiryTimer);
  }

  async #reauthenticate(userId: string, accessToken: string): Promise<void> {
    const outcome = await this.#options.authenticator.authenticate(accessToken);
    if (!outcome.ok) {
      this.#refuse(outcome.refusal);
      return;
    }
    if (outcome.user.userId !== userId) {
      this.#options.logger.warn(
        { userId, newUserId: outcome.user.userId },
        "Closing a client that sent a token for a different user",
      );
      this.#options.close(closeCodes.notAuthenticated, "A token for a different user");
      return;
    }
    this.#closeWhenExpired(outcome.user.validUntil);
  }

  #closeWhenExpired(validUntil: Date | undefined): void {
    clearTimeout(this.#expiryTimer);
    if (validUntil === undefined || this.#isDisposed) {
      return;
    }
    const remainingMilliseconds = validUntil.getTime() - Date.now();
    if (remainingMilliseconds <= 0) {
      this.#options.close(closeCodes.accessTokenExpired, "The access token expired");
      return;
    }
    this.#expiryTimer = setTimeout(
      () => this.#closeWhenExpired(validUntil),
      Math.min(remainingMilliseconds, longestTimerDelayInMilliseconds),
    );
  }

  #refuse(refusal: AuthenticationRefusal): void {
    const { close } = this.#options;
    switch (refusal) {
      case "not_authenticated":
        close(closeCodes.notAuthenticated, "The access token is not valid");
        return;
      case "access_token_expired":
        close(closeCodes.accessTokenExpired, "The access token expired");
        return;
      case "not_allowed":
        close(closeCodes.userNotAllowed, "Not allowed on this installation");
        return;
      case "unavailable":
        close(standardCloseCodes.tryAgainLater, "Could not check the token; try again");
        return;
    }
  }
}
