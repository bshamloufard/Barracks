/** Who is signed in, as far as the page needs to know. */
export type SignedInSession = {
  /** Undefined for development mode's one user, who has none. */
  emailAddress: string | undefined;
  accessToken: string;
};

/**
 * What asking for the session came to:
 * - `signed_in`: here it is, with a token that has not expired.
 * - `signed_out`: there definitely is none. None is stored, or the sign-in
 *   service refused it, and it is gone.
 * - `unavailable`: a session is stored, but its token could not be refreshed
 *   now, typically because the network is down. The session is kept, and
 *   asking again later may succeed; this must never sign the user out.
 */
export type SessionLookup =
  | { status: "signed_in"; session: SignedInSession }
  | { status: "signed_out" }
  | { status: "unavailable"; reason: string };

/** The same three answers, for the access token alone. */
export type AccessTokenLookup =
  | { status: "available"; accessToken: string }
  | { status: "signed_out" }
  | { status: "unavailable"; reason: string };

/**
 * Where the page gets the access token that every request and connection
 * to the control plane carries.
 */
export interface AccessTokenSource {
  /** The current token, refreshed first if it has expired. */
  currentAccessToken(): Promise<AccessTokenLookup>;
  /** A new token now, for when the control plane said the current one expired. */
  refreshAccessToken(): Promise<AccessTokenLookup>;
}

/**
 * The sign-in service behind the page: Supabase Auth, or development mode's
 * one fixed user. The page never sees a secret: Supabase's publishable key
 * is public, and development mode's token is handed to anyone who asks.
 */
export interface SignInService extends AccessTokenSource {
  /** Whether users sign in at all; in development mode they are always signed in. */
  readonly hasSignIn: boolean;
  /** The session kept from an earlier visit, if there is one. */
  restoreSession(): Promise<SessionLookup>;
  /** Emails a six-digit code to the address. */
  requestCode(emailAddress: string): Promise<void>;
  /** Signs in with the code; rejects with a message for the user if it is wrong or stale. */
  verifyCode(emailAddress: string, code: string): Promise<void>;
  /** Deletes this browser's session, refresh token included. */
  signOut(): Promise<void>;
  /**
   * Calls `listener` whenever the session changes: on signing in or out, and
   * with every refreshed token. Returns a function that stops the calls.
   */
  onSessionChanged(listener: (session: SignedInSession | undefined) => void): () => void;
}

/** The token of a session lookup, in the same terms. */
export function accessTokenOf(lookup: SessionLookup): AccessTokenLookup {
  return lookup.status === "signed_in"
    ? { status: "available", accessToken: lookup.session.accessToken }
    : lookup;
}
