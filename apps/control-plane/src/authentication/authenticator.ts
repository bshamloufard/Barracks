import type { Logger } from "../logger.js";
import type { UserStore } from "../users/user-store.js";
import type { AccessTokenVerifier } from "./access-token-verifier.js";
import { isAdmitted, type UserAdmission } from "./user-admission.js";

/** A user the control plane has verified, admitted and recorded. */
export type AuthenticatedUser = {
  userId: string;
  /** When the token that proved it stops being accepted; undefined if it never does. */
  validUntil: Date | undefined;
};

/**
 * Why an access token did not authenticate anyone:
 * - `not_authenticated`: not a token this installation accepts.
 * - `access_token_expired`: a genuine token, too old; a fresh one will do.
 * - `not_allowed`: a genuine user whom this installation does not admit.
 * - `unavailable`: it could not be decided now (the sign-in service or the
 *   database could not be reached).
 */
export type AuthenticationRefusal =
  | "not_authenticated"
  | "access_token_expired"
  | "not_allowed"
  | "unavailable";

export type AuthenticationOutcome =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; refusal: AuthenticationRefusal };

export type AuthenticatorOptions = {
  verifier: AccessTokenVerifier;
  admission: UserAdmission;
  userStore: UserStore;
  logger: Logger;
};

/**
 * The one judgement of an access token, shared by the HTTP API and the
 * client WebSocket: verify it, check the installation admits the user, and
 * record the user on their first authenticated request, so a thread is only
 * ever recorded for a known user.
 */
export class Authenticator {
  readonly #options: AuthenticatorOptions;
  /** Users this process has recorded already, so most requests skip the database. */
  readonly #recordedUserIds = new Set<string>();

  constructor(options: AuthenticatorOptions) {
    this.#options = options;
  }

  async authenticate(accessToken: string): Promise<AuthenticationOutcome> {
    const { verifier, admission, logger } = this.#options;
    const verification = await verifier.verify(accessToken);
    if (!verification.ok) {
      logger.info(
        { failure: verification.failure, detail: verification.detail },
        "Refused an access token",
      );
      return { ok: false, refusal: refusalFor(verification.failure) };
    }
    const { identity } = verification;
    if (!isAdmitted(admission, identity)) {
      logger.warn(
        { userId: identity.userId },
        "Refused a signed-in user whom this installation does not admit",
      );
      return { ok: false, refusal: "not_allowed" };
    }
    if (!(await this.#recordUser(identity.userId))) {
      return { ok: false, refusal: "unavailable" };
    }
    return { ok: true, user: { userId: identity.userId, validUntil: identity.validUntil } };
  }

  async #recordUser(userId: string): Promise<boolean> {
    if (this.#recordedUserIds.has(userId)) {
      return true;
    }
    try {
      await this.#options.userStore.recordUser(userId);
    } catch (error) {
      this.#options.logger.error({ err: error, userId }, "Could not record a signed-in user");
      return false;
    }
    if (!this.#recordedUserIds.has(userId)) {
      this.#recordedUserIds.add(userId);
      this.#options.logger.info({ userId }, "A user signed in for the first time since startup");
    }
    return true;
  }
}

function refusalFor(failure: "expired" | "invalid" | "unavailable"): AuthenticationRefusal {
  switch (failure) {
    case "expired":
      return "access_token_expired";
    case "invalid":
      return "not_authenticated";
    case "unavailable":
      return "unavailable";
  }
}
