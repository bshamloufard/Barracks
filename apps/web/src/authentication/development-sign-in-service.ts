import type { SignedInSession, SignInService } from "./sign-in-service";

/**
 * A control plane in development mode has one fixed user, whose token it
 * hands to every page. There is nothing to sign in or out of, and the token
 * never changes or expires.
 */
export class DevelopmentSignInService implements SignInService {
  readonly hasSignIn = false;
  readonly #session: SignedInSession;

  constructor(accessToken: string) {
    this.#session = { emailAddress: undefined, accessToken };
  }

  async restoreSession(): Promise<SignedInSession> {
    return this.#session;
  }

  async currentAccessToken(): Promise<string> {
    return this.#session.accessToken;
  }

  async refreshAccessToken(): Promise<string> {
    return this.#session.accessToken;
  }

  async requestCode(): Promise<void> {
    throw new Error("Development mode has no sign-in.");
  }

  async verifyCode(): Promise<void> {
    throw new Error("Development mode has no sign-in.");
  }

  async signOut(): Promise<void> {
    throw new Error("Development mode has no sign-in.");
  }

  onSessionChanged(): () => void {
    return () => undefined;
  }
}
