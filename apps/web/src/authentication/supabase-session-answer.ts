import {
  type AuthError,
  isAuthRefreshDiscardedError,
  isAuthRetryableFetchError,
  type Session,
} from "@supabase/supabase-js";
import type { SessionLookup } from "./sign-in-service";

/**
 * What supabase-js's answer about the session means for the page. Only a
 * definite answer may sign the user out, because signing out deletes the
 * refresh token, and with it the only way back short of a new code.
 *
 * supabase-js (2.119.2, `GoTrueClient` `__loadSession` and
 * `_callRefreshToken`) answers `getSession` and `refreshSession` with no
 * session and an error whenever a refresh it needed failed, so "no session"
 * alone says nothing. It tells the failures apart itself:
 * - `AuthRetryableFetchError`: no response (offline, a laptop waking before
 *   its network), or a 5xx or Cloudflare 52x status. It keeps the stored
 *   session, so the page must wait and ask again.
 * - `AuthRefreshDiscardedError`: another call or tab replaced or removed the
 *   stored session during the refresh. Asking again reads what it left.
 * - Anything else (Supabase refused the refresh token, or the session is
 *   missing): it removes the stored session once the access token has really
 *   expired, and keeps it otherwise, in which case `getSession` returns it
 *   with no error. Either way no session comes back only when none is left.
 * https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/src/GoTrueClient.ts
 */
export function interpretSessionAnswer(
  session: Session | null,
  error: AuthError | null,
): SessionLookup {
  if (session !== null) {
    return {
      status: "signed_in",
      session: { emailAddress: session.user.email, accessToken: session.access_token },
    };
  }
  if (error !== null && (isAuthRetryableFetchError(error) || isAuthRefreshDiscardedError(error))) {
    return {
      status: "unavailable",
      reason: `Could not refresh your sign-in with Supabase: ${error.message}`,
    };
  }
  return { status: "signed_out" };
}
