/**
 * The control plane's record of the people who use it, one per user of the
 * sign-in service, keyed by that service's stable user identifier (Supabase's
 * `sub`). Threads belong to a user recorded here. Nothing else is kept about
 * a user yet: not even their email address, which the sign-in service holds.
 */
export interface UserStore {
  /**
   * Records the user if they are not yet recorded, and does nothing if they
   * are, however many requests ask at once.
   */
  recordUser(userId: string): Promise<void>;

  /** Whether the user has been recorded. */
  hasUser(userId: string): Promise<boolean>;
}
