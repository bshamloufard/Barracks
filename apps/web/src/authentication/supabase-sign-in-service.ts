import {
  type AuthError,
  createClient,
  isAuthApiError,
  isAuthPKCECodeVerifierMissingError,
  isAuthRetryableFetchError,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { RevertibleStorage } from "./revertible-storage";
import { describeSignInEmailFailure } from "./sign-in-email-failure";
import {
  describeSignInLinkFailure,
  linkFailureOfErrorCode,
  type SignInLinkFailure,
} from "./sign-in-link";
import {
  type AccessTokenLookup,
  accessTokenOf,
  type SessionLookup,
  type SignedInSession,
  type SignInService,
} from "./sign-in-service";
import { interpretSessionAnswer } from "./supabase-session-answer";

/**
 * Signs in with Supabase Auth by email: the email carries a link, and a
 * code too where the project's template has been edited to show one (see
 * the deployment guide). supabase-js keeps the session in the browser's
 * local storage and refreshes its access token before it expires; while a
 * tab is hidden it pauses refreshing, so a token can be stale when the tab
 * returns, which `currentAccessToken` and the connection's
 * reconnect-on-expiry both cope with. A refresh that cannot reach Supabase
 * is reported as `unavailable`, never as signed out (see
 * `interpretSessionAnswer`).
 *
 * The link, under PKCE (Supabase's documentation, "PKCE flow"): asking for
 * the email stores a code verifier in this browser's storage and sends
 * Supabase its challenge; the link goes to Supabase's `/auth/v1/verify`,
 * which sends the browser back to the redirect with `?code=<auth code>`,
 * valid for five minutes and once; and the code is exchanged for a session
 * with the stored verifier. So a link signs in only the browser that asked.
 * A user's first email is Supabase's "Confirm signup" one rather than its
 * "Magic Link" one (`MagicLink` in supabase/auth's `magic_link.go` signs a
 * new address up instead), and its link comes back the same way.
 * https://supabase.com/docs/guides/auth/auth-email-passwordless
 */
export class SupabaseSignInService implements SignInService {
  readonly hasSignIn = true;
  readonly #client: SupabaseClient;
  readonly #storage = new RevertibleStorage();
  readonly #linkTarget: string;

  /**
   * `pageAddress` is the address the page was served at: links come back
   * to its origin, the installation's own, and to nothing it names after
   * that, so the redirect never depends on what the address carried.
   */
  constructor(supabaseUrl: string, publishableKey: string, pageAddress: string) {
    this.#linkTarget = new URL(pageAddress).origin;
    this.#client = createClient(supabaseUrl, publishableKey, {
      auth: {
        // supabase-js still defaults to the implicit flow; PKCE keeps a
        // link's auth code bound to the browser that asked for it.
        flowType: "pkce",
        autoRefreshToken: true,
        persistSession: true,
        storage: this.#storage,
        // The page reads a link's return itself (`takeSignInReturn`).
        // supabase-js's own detection (`_initialize` in its GoTrueClient)
        // would take any `?code=` for Supabase's while a verifier is stored,
        // GitHub's callback included; would leave a refused link's error in
        // the address; and would ignore a code silently when this browser
        // holds no verifier, so nobody would say why.
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

  /**
   * Supabase sends the link to the redirect only if it is the project's
   * Site URL's origin or on its Redirect URLs, and to the Site URL
   * otherwise, so both must name this installation. A refused request
   * leaves this browser's storage as it was, so the link of an email asked
   * for before still works (see `RevertibleStorage`).
   */
  async sendSignInEmail(emailAddress: string): Promise<void> {
    const { error } = await this.#storage.revertUnless(
      () =>
        this.#client.auth.signInWithOtp({
          email: emailAddress,
          options: { emailRedirectTo: this.#linkTarget },
        }),
      (answer) => answer.error === null,
    );
    if (error !== null) {
      const errorCode = isAuthApiError(error) ? error.code : undefined;
      throw new Error(describeSignInEmailFailure(errorCode, error.message));
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

  /**
   * On success supabase-js stores the session and reports it, which signs
   * the page in. Whatever the outcome it removes the stored verifier, so a
   * link that failed cannot be tried again, nor can an older one.
   */
  async finishSignInWithLink(authCode: string): Promise<void> {
    const { error } = await this.#client.auth.exchangeCodeForSession(authCode);
    if (error !== null) {
      throw new Error(describeSignInLinkFailure(linkFailureOf(error)));
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

/**
 * supabase-js finds no verifier before asking Supabase anything
 * (`AuthPKCECodeVerifierMissingError`) when this browser did not ask for
 * the link, or its storage was cleared since; other failures are
 * Supabase's answer, or no answer.
 */
function linkFailureOf(error: AuthError): SignInLinkFailure {
  if (isAuthPKCECodeVerifierMissingError(error)) {
    return { kind: "not_this_browser" };
  }
  if (isAuthRetryableFetchError(error)) {
    return { kind: "unreachable", detail: error.message };
  }
  return linkFailureOfErrorCode(isAuthApiError(error) ? error.code : undefined, error.message);
}

function toSignedInSession(session: Session | null): SignedInSession | undefined {
  if (session === null) {
    return undefined;
  }
  return { emailAddress: session.user.email, accessToken: session.access_token };
}
