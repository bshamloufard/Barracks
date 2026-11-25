/**
 * Where the page is in signing the user in, changed only by this pure
 * reducer: signed out (asking for an email address, then saying the email
 * is on its way, where a code from it can be typed), signed in, or signed
 * in but refused by this installation.
 */
export type SignInState =
  | { name: "restoring" }
  | { name: "unavailable"; reason: string }
  | {
      name: "signed_out";
      step: "email" | "check_email";
      emailAddress: string;
      isBusy: boolean;
      errorMessage: string | undefined;
    }
  | { name: "signed_in"; emailAddress: string | undefined }
  | { name: "not_allowed"; emailAddress: string | undefined };

export type SignInAction =
  | { type: "session_restore_failed"; reason: string }
  | { type: "session_changed"; emailAddress: string | undefined; isSignedIn: boolean }
  | { type: "email_requested"; emailAddress: string }
  | { type: "email_sent" }
  | { type: "code_submitted" }
  | { type: "attempt_failed"; errorMessage: string }
  /** A sign-in link the page opened from did not sign the user in. */
  | { type: "link_failed"; errorMessage: string }
  | { type: "different_email_chosen" }
  /** The control plane refused the signed-in user: they are not on this installation's list. */
  | { type: "access_refused" };

export const initialSignInState: SignInState = { name: "restoring" };

type SignedOutState = Extract<SignInState, { name: "signed_out" }>;

const freshSignIn: SignedOutState = {
  name: "signed_out",
  step: "email",
  emailAddress: "",
  isBusy: false,
  errorMessage: undefined,
};

export function reduceSignInState(state: SignInState, action: SignInAction): SignInState {
  switch (action.type) {
    case "session_restore_failed":
      return { name: "unavailable", reason: action.reason };
    case "session_changed":
      return applySessionChange(state, action.isSignedIn, action.emailAddress);
    case "access_refused":
      return state.name === "signed_in"
        ? { name: "not_allowed", emailAddress: state.emailAddress }
        : state;
    case "different_email_chosen":
      return freshSignIn;
    default:
      return state.name === "signed_out" ? applySignInStep(state, action) : state;
  }
}

/**
 * A refreshed token for the same user keeps a refusal in place: being
 * refused does not change with a new token, only with signing out. Being
 * told again that nobody is signed in changes nothing, so it does not wipe
 * what the page is saying, a failed link's reason say.
 */
function applySessionChange(
  state: SignInState,
  isSignedIn: boolean,
  emailAddress: string | undefined,
): SignInState {
  if (!isSignedIn) {
    return state.name === "signed_out" ? state : freshSignIn;
  }
  if (state.name === "not_allowed" && state.emailAddress === emailAddress) {
    return state;
  }
  return { name: "signed_in", emailAddress };
}

function applySignInStep(state: SignedOutState, action: SignInAction): SignInState {
  switch (action.type) {
    case "email_requested":
      return { ...state, emailAddress: action.emailAddress, isBusy: true, errorMessage: undefined };
    case "email_sent":
      return { ...state, step: "check_email", isBusy: false };
    case "code_submitted":
      return { ...state, isBusy: true, errorMessage: undefined };
    case "attempt_failed":
      return { ...state, isBusy: false, errorMessage: action.errorMessage };
    case "link_failed":
      return { ...freshSignIn, errorMessage: action.errorMessage };
    default:
      return state;
  }
}
