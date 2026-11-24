import { z } from "zod";
import { type SupabaseProject, userEndpointUrlOf } from "./supabase-project.js";

/**
 * A Supabase access token carries the user's `email`, but no claim saying the
 * user proved they receive mail there: the `email_verified` some tokens show
 * sits in `user_metadata`, which users can change themselves. Supabase Auth
 * itself knows (`email_confirmed_at`), so this asks it, once per user and
 * address for as long as the control plane runs, and only for installations
 * that admit users by email address.
 * https://supabase.com/docs/guides/auth/jwt-fields
 */

export type EmailConfirmation =
  | { outcome: "confirmed" }
  | { outcome: "not_confirmed" }
  /** Supabase refused the token itself, for example because the session was signed out. */
  | { outcome: "token_refused" }
  | { outcome: "unavailable"; detail: string };

const userResponseSchema = z.object({
  email: z.string().optional(),
  email_confirmed_at: z.string().nullable().optional(),
});

/** Long enough for a slow answer, short enough that a request waiting on it still feels prompt. */
const requestTimeoutInMilliseconds = 5_000;

export class SupabaseEmailConfirmations {
  readonly #project: SupabaseProject;
  readonly #confirmedUserAddresses = new Set<string>();

  constructor(project: SupabaseProject) {
    this.#project = project;
  }

  /** Whether `emailAddress` (lower-cased) is the confirmed address of the token's user. */
  async check(
    accessToken: string,
    userId: string,
    emailAddress: string,
  ): Promise<EmailConfirmation> {
    const cacheKey = `${userId}\n${emailAddress}`;
    if (this.#confirmedUserAddresses.has(cacheKey)) {
      return { outcome: "confirmed" };
    }
    const confirmation = await this.#askSupabase(accessToken, emailAddress);
    if (confirmation.outcome === "confirmed") {
      this.#confirmedUserAddresses.add(cacheKey);
    }
    return confirmation;
  }

  async #askSupabase(accessToken: string, emailAddress: string): Promise<EmailConfirmation> {
    let response: Response;
    try {
      response = await fetch(userEndpointUrlOf(this.#project), {
        headers: { Authorization: `Bearer ${accessToken}`, apikey: this.#project.publishableKey },
        signal: AbortSignal.timeout(requestTimeoutInMilliseconds),
      });
    } catch (error) {
      return { outcome: "unavailable", detail: `Supabase Auth could not be reached: ${error}` };
    }
    if (response.status === 401 || response.status === 403) {
      return { outcome: "token_refused" };
    }
    if (!response.ok) {
      return {
        outcome: "unavailable",
        detail: `Supabase Auth answered HTTP ${response.status} when asked about a user`,
      };
    }
    const user = userResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!user.success) {
      return {
        outcome: "unavailable",
        detail: "Supabase Auth described a user in an unknown shape",
      };
    }
    const isConfirmed =
      user.data.email?.toLowerCase() === emailAddress &&
      typeof user.data.email_confirmed_at === "string";
    return { outcome: isConfirmed ? "confirmed" : "not_confirmed" };
  }
}
