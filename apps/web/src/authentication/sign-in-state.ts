/**
 * Where the page is in signing the user in, changed only by this pure
 * reducer: signed out (asking for an email address, then for the code sent
 * to it), signed in, or signed in but refused by this installation.
 */
export type SignInState =
  | { name: "restoring" }
  | { name: "unavailable"; reason: string }
  | {
      name: "signed_out";
      step: "email" | "code";
      emailAddress: string;
      isBusy: boolean;
      errorMessage: string | undefined;
    }
  | { name: "signed_in"; emailAddress: string | undefined }
  | { name: "not_allowed"; emailAddress: string | undefined };

export type SignInAction =
  | { type: "session_restore_failed"; reason: string }
  | { type: "session_changed"; emailAddress: string | undefined; isSignedIn: boolean }
  | { type: "code_requested"; emailAddress: string }
  | { type: "code_sent" }
  | { type: "code_submitted" }
  | { type: "attempt_failed"; errorMessage: string }
  | { type: "different_email_chosen" }
  /** The control plane refused the signed-in user: they are not on this installation's list. */
  | { type: "access_refused" };

export const initialSignInState: SignInState = { name: "restoring" };

const freshSignIn: SignInState = {
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
 * refused does not change with a new token, only with signing out.
 */
function applySessionChange(
  state: SignInState,
  isSignedIn: boolean,
  emailAddress: string | undefined,
): SignInState {
  if (!isSignedIn) {
    return freshSignIn;
  }
  if (state.name === "not_allowed" && state.emailAddress === emailAddress) {
    return state;
  }
  return { name: "signed_in", emailAddress };
}

type SignedOutState = Extract<SignInState, { name: "signed_out" }>;

function applySignInStep(state: SignedOutState, action: SignInAction): SignInState {
  switch (action.type) {
    case "code_requested":
      return { ...state, emailAddress: action.emailAddress, isBusy: true, errorMessage: undefined };
    case "code_sent":
      return { ...state, step: "code", isBusy: false };
    case "code_submitted":
      return { ...state, isBusy: true, errorMessage: undefined };
    case "attempt_failed":
      return { ...state, isBusy: false, errorMessage: action.errorMessage };
    default:
      return state;
  }
}
