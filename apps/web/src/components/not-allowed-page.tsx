import type { SessionController } from "../authentication/session-controller";

/** A signed-in user this installation does not admit; the control plane decided, not the page. */
export function NotAllowedPage({
  emailAddress,
  session,
}: {
  emailAddress: string | undefined;
  session: SessionController;
}) {
  return (
    <div className="page">
      <header className="page-header">
        <h1>Barrack</h1>
      </header>
      <main>
        <p className="error-notice" role="alert">
          You are signed in as {emailAddress ?? "an account without an email address"}, but this
          installation of Barrack does not let you use it. Ask whoever runs it to add your email
          address.
        </p>
        <button type="button" className="primary-button" onClick={() => void session.signOut()}>
          Sign out
        </button>
      </main>
    </div>
  );
}
