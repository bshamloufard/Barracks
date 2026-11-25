import { type FormEvent, useState } from "react";
import { longestOneTimeCode, oneTimeCodePattern } from "../authentication/one-time-code";
import type { SessionController } from "../authentication/session-controller";
import type { SignInState } from "../authentication/sign-in-state";

type SignedOutState = Extract<SignInState, { name: "signed_out" }>;

/**
 * One screen: an email address, then word that the email is on its way,
 * to be finished by its link, in this browser, or by the code it may show.
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
          <CheckEmailForm state={state} session={session} />
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
    </form>
  );
}

/**
 * The link works only in the browser that asked for it, because the code it
 * brings back is exchanged with a secret this browser stored (PKCE), so the
 * page says so before the user opens it anywhere else.
 */
function CheckEmailForm({ state, session }: { state: SignedOutState; session: SessionController }) {
  const [code, setCode] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    session.submitCode(code.trim());
  };
  return (
    <form className="sign-in-form" onSubmit={submit}>
      <p>An email is on its way to {state.emailAddress}.</p>
      <p>
        Open the link in it in this browser, the one you asked from: the link signs in only the
        browser that asked for it. (The first time, the email asks you to confirm your address; that
        link signs you in too.) If you opened it in another browser or on another device, come back
        here and send another email.
      </p>
      <label htmlFor="sign-in-code">Or, if the email shows a code, enter it here</label>
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
        Send another email
      </button>
      <button type="button" className="quiet-button" onClick={() => session.chooseDifferentEmail()}>
        Use a different email address
      </button>
    </form>
  );
}
