/**
 * Given an access token, who is this, or why not. Both transports ask the
 * same question of the same verifier, through the `Authenticator`, so a
 * token is judged the same way over HTTP and over a WebSocket. Tests and the
 * development mode use other verifiers, so neither needs Supabase.
 */
export interface AccessTokenVerifier {
  verify(accessToken: string): Promise<AccessTokenVerification>;
}

export type VerifiedIdentity = {
  /** The sign-in service's stable identifier for the user (Supabase's `sub`). */
  userId: string;
  /**
   * The user's email address, only when the sign-in service confirms the
   * user proved they receive mail there; otherwise undefined. Lower-cased.
   */
  confirmedEmailAddress: string | undefined;
  /**
   * When the token stops being accepted, clock tolerance included, or
   * undefined for one that never expires (the development user's).
   */
  validUntil: Date | undefined;
};

/**
 * - `expired`: a genuine token that is too old; a fresh one will do.
 * - `invalid`: not a token this installation accepts, for any other reason.
 * - `unavailable`: it could not be checked now (the sign-in service could
 *   not be reached), which says nothing about the token.
 *
 * `detail` is for the log, and never contains the token.
 */
export type AccessTokenVerification =
  | { ok: true; identity: VerifiedIdentity }
  | { ok: false; failure: "expired" | "invalid" | "unavailable"; detail: string };
