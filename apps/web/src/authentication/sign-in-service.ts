/** Who is signed in, as far as the page needs to know. */
export type SignedInSession = {
  /** Undefined for development mode's one user, who has none. */
  emailAddress: string | undefined;
  accessToken: string;
};

/**
 * Where the page gets the access token that every request and connection
 * to the control plane carries.
 */
export interface AccessTokenSource {
  /** The current token, refreshed first if it has expired; undefined when signed out. */
  currentAccessToken(): Promise<string | undefined>;
  /** A new token now, for when the control plane said the current one expired. */
  refreshAccessToken(): Promise<string | undefined>;
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
  restoreSession(): Promise<SignedInSession | undefined>;
  /** Emails a six-digit code to the address. */
  requestCode(emailAddress: string): Promise<void>;
  /** Signs in with the code; rejects with a message for the user if it is wrong or stale. */
  verifyCode(emailAddress: string, code: string): Promise<void>;
  signOut(): Promise<void>;
  /**
   * Calls `listener` whenever the session changes: on signing in or out, and
   * with every refreshed token. Returns a function that stops the calls.
   */
  onSessionChanged(listener: (session: SignedInSession | undefined) => void): () => void;
}
