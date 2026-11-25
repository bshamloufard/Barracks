/**
 * What the address said when the page opened from a sign-in link:
 * - `none`: it is not a return from a sign-in link.
 * - `link`: Supabase accepted the link and sent back an auth code, which
 *   this browser exchanges for a session with the code verifier it stored
 *   when it asked for the email.
 * - `refused`: Supabase refused the link before sending a code (it expired,
 *   or was used already), saying why in `errorCode`.
 */
export type SignInReturn =
  | { kind: "none" }
  | { kind: "link"; authCode: string }
  | { kind: "refused"; errorCode: string | undefined };

/** How a sign-in link failed, as far as the user can do anything about it. */
export type SignInLinkFailure =
  | { kind: "expired_or_used" }
  | { kind: "not_this_browser" }
  | { kind: "superseded" }
  | { kind: "unreachable"; detail: string }
  | { kind: "not_accepted"; detail: string | undefined };

/**
 * The members Supabase Auth adds to the address it sends a link back to
 * (`internal/api/verify.go` in supabase/auth: `prepPKCERedirectURL` and
 * `prepErrorRedirectURL`): under PKCE a successful link returns to
 * `<redirect>?code=<auth code>`, and a refused one to
 * `<redirect>?error=…&error_code=…&error_description=…` with the same three
 * and `sb` in the fragment as well. `sb_flow_id` is supabase-js's own, sent
 * only when an experimental setting this client leaves off is on.
 */
const queryMembers = ["code", "error", "error_code", "error_description", "sb_flow_id"];
const fragmentMembers = [
  "sb",
  "error",
  "error_code",
  "error_description",
  "access_token",
  "refresh_token",
];

/** The page's location and history, as far as reading and cleaning the address needs them. */
export type PageWindow = {
  location: { href: string };
  history: { state: unknown; replaceState(state: unknown, unused: string, url: string): void };
};

/**
 * Reads a return from a sign-in link once, when the page opens, and takes
 * what Supabase added out of the address at once, before anything else
 * runs: a reload or a copied address then cannot replay the code (it is
 * single-use anyway), and nothing from it stays in the history. Only the
 * page's root is a return, because that is where links are sent (see
 * `SupabaseSignInService`); GitHub's callback, which also carries a `code`,
 * is at a path of its own and is left alone, as is every other member of
 * the query. Nothing read here is logged.
 */
export function takeSignInReturn(page: PageWindow): SignInReturn {
  const address = new URL(page.location.href);
  if (address.pathname !== "/") {
    return { kind: "none" };
  }
  const fragment = new URLSearchParams(address.hash.slice(1));
  const read = (name: string) => address.searchParams.get(name) ?? fragment.get(name) ?? undefined;
  const signInReturn = readSignInReturn(read);
  const hasQueryMembers = queryMembers.some((name) => address.searchParams.has(name));
  const hasFragmentMembers = fragmentMembers.some((name) => fragment.has(name));
  if (!hasQueryMembers && !hasFragmentMembers) {
    return signInReturn;
  }
  for (const name of queryMembers) {
    address.searchParams.delete(name);
  }
  if (hasFragmentMembers) {
    address.hash = "";
  }
  page.history.replaceState(
    page.history.state,
    "",
    `${address.pathname}${address.search}${address.hash}`,
  );
  return signInReturn;
}

function readSignInReturn(read: (name: string) => string | undefined): SignInReturn {
  const errorCode = read("error_code");
  if (
    errorCode !== undefined ||
    read("error") !== undefined ||
    read("error_description") !== undefined
  ) {
    return { kind: "refused", errorCode };
  }
  const authCode = read("code");
  return authCode === undefined || authCode === "" ? { kind: "none" } : { kind: "link", authCode };
}

/**
 * Supabase's error codes for a link it refused or a code it would not
 * exchange (Supabase's documentation, "Error codes"): `otp_expired` for a
 * link that expired or was used already, `flow_state_expired` and
 * `flow_state_not_found` for a sign-in whose record Supabase no longer
 * holds, and `bad_code_verifier` for a link from an earlier request.
 */
export function linkFailureOfErrorCode(
  errorCode: string | undefined,
  detail: string | undefined,
): SignInLinkFailure {
  switch (errorCode) {
    case "otp_expired":
    case "flow_state_expired":
    case "flow_state_not_found":
      return { kind: "expired_or_used" };
    case "bad_code_verifier":
      return { kind: "superseded" };
    default:
      return { kind: "not_accepted", detail };
  }
}

/**
 * What the page says about a link that did not sign the user in. It shows
 * on the form that asks for the email again, so each ends by saying to ask
 * again here. A refusal's own description, read from the address, is never
 * shown: anyone can send a link to this page carrying any text there.
 */
export function describeSignInLinkFailure(failure: SignInLinkFailure): string {
  switch (failure.kind) {
    case "expired_or_used":
      return "That sign-in link has expired or has been used already: each link works once, and only for a while. Ask for a new one here.";
    case "not_this_browser":
      return "That sign-in link was not asked for in this browser, or this browser has used up its request already: a link works only in the browser that asked for it. Ask for a new one here, and open it in this browser.";
    case "superseded":
      return "That sign-in link is from an earlier email, which asking again replaced. Ask for a new one here, and open the link in the newest email only.";
    case "unreachable":
      return `Could not reach Supabase to finish signing in with that link: ${failure.detail}. Ask for a new one here.`;
    case "not_accepted":
      return failure.detail === undefined
        ? "Supabase did not accept that sign-in link. Ask for a new one here."
        : `Supabase did not accept that sign-in link: ${failure.detail}. Ask for a new one here.`;
  }
}
