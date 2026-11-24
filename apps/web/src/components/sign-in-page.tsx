import { type FormEvent, useState } from "react";
import type { SessionController } from "../authentication/session-controller";
import type { SignInState } from "../authentication/sign-in-state";

type SignedOutState = Extract<SignInState, { name: "signed_out" }>;

/** One screen: an email address, then the six-digit code emailed to it. */
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
    session.requestCode(emailAddress.trim());
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
        {state.isBusy ? "Sending…" : "Email me a code"}
      </button>
    </form>
  );
}

function CodeForm({ state, session }: { state: SignedOutState; session: SessionController }) {
  const [code, setCode] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    session.submitCode(code.trim());
  };
  return (
    <form className="sign-in-form" onSubmit={submit}>
      <label htmlFor="sign-in-code">Enter the six-digit code sent to {state.emailAddress}</label>
      <input
        id="sign-in-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required={true}
        value={code}
        disabled={state.isBusy}
        onChange={(event) => setCode(event.target.value)}
      />
      <button type="submit" className="primary-button" disabled={state.isBusy}>
        {state.isBusy ? "Checking…" : "Sign in"}
      </button>
      <button type="button" className="quiet-button" onClick={() => session.chooseDifferentEmail()}>
        Use a different email address
      </button>
    </form>
  );
}
