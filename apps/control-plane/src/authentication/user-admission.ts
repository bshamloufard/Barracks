import type { VerifiedIdentity } from "./access-token-verifier.js";

/**
 * Who may use this installation, beyond being able to sign in. A Supabase
 * project accepts sign-ups from anyone by default, and every user can spend
 * the operator's sandbox budget, so an installation admits by default only
 * the email addresses it lists, matched against the address Supabase
 * confirms the user owns. Admitting everyone who can sign in must be asked
 * for in so many words.
 */
export type UserAdmission =
  | { kind: "listed-email-addresses"; emailAddresses: ReadonlySet<string> }
  | { kind: "anyone-who-can-sign-in" };

export function isAdmitted(admission: UserAdmission, identity: VerifiedIdentity): boolean {
  if (admission.kind === "anyone-who-can-sign-in") {
    return true;
  }
  const { confirmedEmailAddress } = identity;
  return confirmedEmailAddress !== undefined && admission.emailAddresses.has(confirmedEmailAddress);
}
