import { createAuthorizedFetch } from "../api/authorized-fetch";
import { ThreadsApi } from "../api/threads-api";
import type { AccessTokenSource, SignedInSession, SignInService } from "./sign-in-service";
import {
  initialSignInState,
  reduceSignInState,
  type SignInAction,
  type SignInState,
} from "./sign-in-state";

/**
 * The page's one session: it carries out sign-in through the sign-in
 * service and keeps the resulting state, which React reads through
 * `subscribe` and `getState`. Everything that talks to the control plane
 * gets its tokens here, and reports here when the control plane refuses
 * the user, so a refusal anywhere changes what the whole page shows.
 */
export class SessionController {
  readonly hasSignIn: boolean;
  readonly accessTokens: AccessTokenSource;
  readonly threadsApi: ThreadsApi;
  readonly #service: SignInService;
  readonly #stateListeners = new Set<() => void>();
  readonly #tokenListeners = new Set<(accessToken: string) => void>();
  #state: SignInState = initialSignInState;
  #lastAccessToken: string | undefined;

  constructor(service: SignInService) {
    this.#service = service;
    this.hasSignIn = service.hasSignIn;
    this.accessTokens = service;
    this.threadsApi = new ThreadsApi(
      createAuthorizedFetch(service, {
        onSignInRequired: () => void this.signOut(),
        onNotAllowed: () => this.#dispatch({ type: "access_refused" }),
      }),
    );
  }

  readonly getState = (): SignInState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  };

  /** Restores any earlier session and follows changes to it until the returned function is called. */
  start(): () => void {
    const stopFollowing = this.#service.onSessionChanged((session) => this.#applySession(session));
    this.#service.restoreSession().then(
      (session) => this.#applySession(session),
      (error: unknown) =>
        this.#dispatch({ type: "session_restore_failed", reason: describeError(error) }),
    );
    return stopFollowing;
  }

  /** Calls `listener` with each new token while signed in, for open connections to send on. */
  onAccessTokenRefreshed(listener: (accessToken: string) => void): () => void {
    this.#tokenListeners.add(listener);
    return () => this.#tokenListeners.delete(listener);
  }

  requestCode(emailAddress: string): void {
    this.#dispatch({ type: "code_requested", emailAddress });
    this.#service.requestCode(emailAddress).then(
      () => this.#dispatch({ type: "code_sent" }),
      (error: unknown) =>
        this.#dispatch({ type: "attempt_failed", errorMessage: describeError(error) }),
    );
  }

  /** On success the service reports the new session, which signs the page in. */
  submitCode(code: string): void {
    const state = this.#state;
    if (state.name !== "signed_out") {
      return;
    }
    this.#dispatch({ type: "code_submitted" });
    this.#service.verifyCode(state.emailAddress, code).catch((error: unknown) => {
      this.#dispatch({ type: "attempt_failed", errorMessage: describeError(error) });
    });
  }

  chooseDifferentEmail(): void {
    this.#dispatch({ type: "different_email_chosen" });
  }

  /** The control plane refused the signed-in user, over a connection rather than a request. */
  reportNotAllowed(): void {
    this.#dispatch({ type: "access_refused" });
  }

  /** Signs out; with no sign-in (development mode) there is nothing to sign out of. */
  async signOut(): Promise<void> {
    if (!this.hasSignIn) {
      return;
    }
    try {
      await this.#service.signOut();
    } catch (error) {
      console.error(error);
    }
    this.#applySession(undefined);
  }

  #applySession(session: SignedInSession | undefined): void {
    this.#dispatch({
      type: "session_changed",
      isSignedIn: session !== undefined,
      emailAddress: session?.emailAddress,
    });
    const accessToken = session?.accessToken;
    if (accessToken === undefined || accessToken === this.#lastAccessToken) {
      this.#lastAccessToken = accessToken;
      return;
    }
    const isRefresh = this.#lastAccessToken !== undefined;
    this.#lastAccessToken = accessToken;
    if (isRefresh) {
      for (const listener of this.#tokenListeners) {
        listener(accessToken);
      }
    }
  }

  #dispatch(action: SignInAction): void {
    this.#state = reduceSignInState(this.#state, action);
    for (const listener of this.#stateListeners) {
      listener();
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
