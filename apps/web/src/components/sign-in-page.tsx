import { type FormEvent, type MouseEvent, useState } from "react";
import { longestOneTimeCode, oneTimeCodePattern } from "../authentication/one-time-code";
import type { SessionController } from "../authentication/session-controller";
import type { SignInState } from "../authentication/sign-in-state";

type SignedOutState = Extract<SignInState, { name: "signed_out" }>;

/**
 * One screen: an email address, then word that the email is on its way,
 * to be finished by its link, in this browser, or by the code it may show;
 * or, for an email the user already has, its code, with none sent.
 */
export function SignInPage({
  state,
  session,
}: {
  state: SignedOutState;
  session: SessionController;
}) {
  return (
    <div className="page sign-in-page">
      <header className="page-header">
        <h1>Barrack</h1>
      </header>
      <main>
        {state.step === "email" ? (
          <EmailForm state={state} session={session} />
        ) : (
          <CodeForm state={state} session={session} />
        )}
        {state.errorMessage !== undefined && (
          <p className="error-notice" role="alert">
            {state.errorMessage}
          </p>
        )}
      </main>
    </div>
  );
}

function EmailForm({ state, session }: { state: SignedOutState; session: SessionController }) {
  const [emailAddress, setEmailAddress] = useState(state.emailAddress);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    session.requestSignInEmail(emailAddress.trim());
  };
  // The form's own check of the address, as sending one would make.
  const enterCode = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.currentTarget.form?.reportValidity() === true) {
      session.enterCodeFromEarlierEmail(emailAddress.trim());
    }
  };
  return (
    <form className="sign-in-form" onSubmit={submit}>
      <label htmlFor="sign-in-email">Sign in with your email address</label>
      <input
        id="sign-in-email"
        type="email"
        autoComplete="email"
        required={true}
        value={emailAddress}
        disabled={state.isBusy}
        onChange={(event) => setEmailAddress(event.target.value)}
      />
      <button type="submit" className="primary-button" disabled={state.isBusy}>
        {state.isBusy ? "Sending…" : "Email me a sign-in link"}
      </button>
      <button type="button" className="quiet-button" disabled={state.isBusy} onClick={enterCode}>
        I already have an email
      </button>
    </form>
  );
}

/**
 * The link works only in the browser that asked for it, because the code it
 * brings back is exchanged with a secret this browser stored (PKCE), so the
 * page says so before the user opens it anywhere else. With no email just
 * sent, it says nothing is on its way, and that the link works only if it
 * is the newest this browser asked for (each email asked for replaces the
 * secret).
 */
function CodeForm({ state, session }: { state: SignedOutState; session: SessionController }) {
  const [code, setCode] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    session.submitCode(code.trim());
  };
  return (
    <form className="sign-in-form" onSubmit={submit}>
      {state.step === "check_email" ? (
        <>
          <p>An email is on its way to {state.emailAddress}.</p>
          <p>
            Open the link in it in this browser, the one you asked from: the link signs in only the
            browser that asked for it. (The first time, the email asks you to confirm your address;
            that link signs you in too.) If you opened it in another browser or on another device,
            come back here and send another email.
          </p>
        </>
      ) : (
        <p>
          No new email was sent. Enter the code from the email you have for {state.emailAddress}. If
          it shows no code, open its link in this browser instead: that works if it is the newest
          email you asked for here.
        </p>
      )}
      <label htmlFor="sign-in-code">
        {state.step === "check_email"
          ? "Or, if the email shows a code, enter it here"
          : "The code in the email"}
      </label>
      <input
        id="sign-in-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern={oneTimeCodePattern}
        maxLength={longestOneTimeCode}
        required={true}
        value={code}
        disabled={state.isBusy}
        onChange={(event) => setCode(event.target.value)}
      />
      <button type="submit" className="primary-button" disabled={state.isBusy}>
        {state.isBusy ? "Checking…" : "Sign in"}
      </button>
      <button
        type="button"
        className="quiet-button"
        disabled={state.isBusy}
        onClick={() => session.requestSignInEmail(state.emailAddress)}
      >
        {state.step === "check_email" ? "Send another email" : "Send a new email"}
      </button>
      <button type="button" className="quiet-button" onClick={() => session.chooseDifferentEmail()}>
        Use a different email address
      </button>
    </form>
  );
}
