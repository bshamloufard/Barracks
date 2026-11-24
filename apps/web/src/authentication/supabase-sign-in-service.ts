import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import {
  type AccessTokenLookup,
  accessTokenOf,
  type SessionLookup,
  type SignedInSession,
  type SignInService,
} from "./sign-in-service";
import { interpretSessionAnswer } from "./supabase-session-answer";

/**
 * Signs in with Supabase Auth by a six-digit code sent by email. supabase-js
 * keeps the session in the browser's local storage and refreshes its access
 * token before it expires; while a tab is hidden it pauses refreshing, so a
 * token can be stale when the tab returns, which `currentAccessToken` and
 * the connection's reconnect-on-expiry both cope with. A refresh that
 * cannot reach Supabase is reported as `unavailable`, never as signed out
 * (see `interpretSessionAnswer`).
 * https://supabase.com/docs/guides/auth/auth-email-passwordless#with-otp
 */
export class SupabaseSignInService implements SignInService {
  readonly hasSignIn = true;
  readonly #client: SupabaseClient;

  constructor(supabaseUrl: string, publishableKey: string) {
    this.#client = createClient(supabaseUrl, publishableKey, {
      auth: {
        // supabase-js still defaults to the implicit flow; PKCE keeps any
        // code a sign-in returns bound to the browser that asked for it.
        flowType: "pkce",
        autoRefreshToken: true,
        persistSession: true,
        // Signing in by code never returns through a URL, so none is read.
        detectSessionInUrl: false,
      },
    });
  }

  async restoreSession(): Promise<SessionLookup> {
    const { data, error } = await this.#client.auth.getSession();
    return interpretSessionAnswer(data.session, error);
  }

  async currentAccessToken(): Promise<AccessTokenLookup> {
    return accessTokenOf(await this.restoreSession());
  }

  /**
   * A refresh Supabase refused while the access token is still valid leaves
   * the session in place, so the stored session, not the refusal, decides.
   */
  async refreshAccessToken(): Promise<AccessTokenLookup> {
    const { data, error } = await this.#client.auth.refreshSession();
    const lookup = interpretSessionAnswer(data.session, error);
    return lookup.status === "signed_out" ? this.currentAccessToken() : accessTokenOf(lookup);
  }

  async requestCode(emailAddress: string): Promise<void> {
    const { error } = await this.#client.auth.signInWithOtp({ email: emailAddress });
    if (error !== null) {
      throw new Error(`Could not send a code: ${error.message}`);
    }
  }

  async verifyCode(emailAddress: string, code: string): Promise<void> {
    const { error } = await this.#client.auth.verifyOtp({
      email: emailAddress,
      token: code,
      type: "email",
    });
    if (error !== null) {
      throw new Error(`That code did not work: ${error.message}`);
    }
  }

  /** Signs this browser out only, leaving the user's other devices signed in. */
  async signOut(): Promise<void> {
    const { error } = await this.#client.auth.signOut({ scope: "local" });
    if (error !== null) {
      throw new Error(`Could not sign out: ${error.message}`);
    }
  }

  /**
   * The callback must not call back into supabase-js synchronously, which
   * its documentation warns can deadlock, so it only passes the session on.
   */
  onSessionChanged(listener: (session: SignedInSession | undefined) => void): () => void {
    const { data } = this.#client.auth.onAuthStateChange((_event, session) => {
      listener(toSignedInSession(session));
    });
    return () => data.subscription.unsubscribe();
  }
}

function toSignedInSession(session: Session | null): SignedInSession | undefined {
  if (session === null) {
    return undefined;
  }
  return { emailAddress: session.user.email, accessToken: session.access_token };
}
