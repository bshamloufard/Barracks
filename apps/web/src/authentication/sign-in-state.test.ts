import { describe, expect, it } from "vitest";
import {
  initialSignInState,
  reduceSignInState,
  type SignInAction,
  type SignInState,
} from "./sign-in-state";

function apply(actions: SignInAction[], state: SignInState = initialSignInState): SignInState {
  return actions.reduce(reduceSignInState, state);
}

const signedOut: SignInAction = {
  type: "session_changed",
  isSignedIn: false,
  emailAddress: undefined,
};
const signedInAsAda: SignInAction = {
  type: "session_changed",
  isSignedIn: true,
  emailAddress: "ada@example.com",
};

describe("signing in", () => {
  it("asks for an email address when there is no session to restore", () => {
    expect(apply([signedOut])).toEqual({
      name: "signed_out",
      step: "email",
      emailAddress: "",
      isBusy: false,
      errorMessage: undefined,
    });
  });

  it("goes from the email address, to the code sent to it, to signed in", () => {
    const askingForEmail = apply([signedOut]);
    const sendingCode = reduceSignInState(askingForEmail, {
      type: "code_requested",
      emailAddress: "ada@example.com",
    });
    const askingForCode = reduceSignInState(sendingCode, { type: "code_sent" });
    const checkingCode = reduceSignInState(askingForCode, { type: "code_submitted" });
    const signedIn = reduceSignInState(checkingCode, signedInAsAda);

    expect(sendingCode).toMatchObject({
      step: "email",
      emailAddress: "ada@example.com",
      isBusy: true,
    });
    expect(askingForCode).toMatchObject({
      step: "code",
      emailAddress: "ada@example.com",
      isBusy: false,
    });
    expect(checkingCode).toMatchObject({ step: "code", isBusy: true });
    expect(signedIn).toEqual({ name: "signed_in", emailAddress: "ada@example.com" });
  });

  it("stays on the step that failed, saying why, and clears the message on the next attempt", () => {
    const failed = apply([
      signedOut,
      { type: "code_requested", emailAddress: "ada@example.com" },
      { type: "code_sent" },
      { type: "code_submitted" },
      { type: "attempt_failed", errorMessage: "That code did not work" },
    ]);
    const retried = reduceSignInState(failed, { type: "code_submitted" });

    expect(failed).toMatchObject({
      step: "code",
      isBusy: false,
      errorMessage: "That code did not work",
    });
    expect(retried).toMatchObject({ step: "code", isBusy: true, errorMessage: undefined });
  });

  it("starts again from the email address when the user chooses a different one", () => {
    const state = apply([
      signedOut,
      { type: "code_requested", emailAddress: "ada@example.com" },
      { type: "code_sent" },
      { type: "different_email_chosen" },
    ]);

    expect(state).toMatchObject({ step: "email", emailAddress: "" });
  });

  it("goes straight to signed in when a session is restored from an earlier visit", () => {
    expect(apply([signedInAsAda])).toEqual({ name: "signed_in", emailAddress: "ada@example.com" });
  });

  it("says the page cannot sign anyone in when the session cannot be read", () => {
    expect(apply([{ type: "session_restore_failed", reason: "Storage is unavailable" }])).toEqual({
      name: "unavailable",
      reason: "Storage is unavailable",
    });
  });
});

describe("a signed-in user this installation refuses", () => {
  it("is shown as not allowed, and stays so when their token is refreshed", () => {
    const refused = apply([signedInAsAda, { type: "access_refused" }]);

    expect(refused).toEqual({ name: "not_allowed", emailAddress: "ada@example.com" });
    expect(reduceSignInState(refused, signedInAsAda)).toBe(refused);
  });

  it("can sign out and sign in as someone else", () => {
    const state = apply([
      signedInAsAda,
      { type: "access_refused" },
      signedOut,
      { type: "session_changed", isSignedIn: true, emailAddress: "grace@example.com" },
    ]);

    expect(state).toEqual({ name: "signed_in", emailAddress: "grace@example.com" });
  });

  it("is not refused by a late answer once signed out", () => {
    expect(apply([signedOut, { type: "access_refused" }])).toMatchObject({ name: "signed_out" });
  });
});
