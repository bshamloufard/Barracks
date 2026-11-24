/**
 * The control plane's record of the people who use it, one per user of the
 * sign-in service, keyed by that service's stable user identifier (Supabase's
 * `sub`). Threads belong to a user recorded here. Nothing else is kept about
 * a user but the digest of the email address the sign-in service last
 * confirmed they own, never the address itself: it lets the model proxy
 * tell, with no request from the user at hand, whether an installation that
 * admits listed addresses still admits them (see `OwnerAdmission`).
 */
export interface UserStore {
  /**
   * Records the user if they are not yet recorded, however many requests
   * ask at once, and notes the digest of their confirmed email address, or
   * that they have none, if that differs from what is recorded.
   */
  recordUser(userId: string, confirmedEmailDigest: Buffer | undefined): Promise<void>;

  /** Whether the user has been recorded. */
  hasUser(userId: string): Promise<boolean>;

  /** The digest last recorded for the user, or undefined for none (or no such user). */
  readConfirmedEmailDigest(userId: string): Promise<Buffer | undefined>;
}
