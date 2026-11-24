import { useSyncExternalStore } from "react";
import { useSession } from "../authentication/session-context";

/** Who is signed in, and a way to sign out; nothing in development mode, which has no sign-in. */
export function AccountBar() {
  const session = useSession();
  const state = useSyncExternalStore(session.subscribe, session.getState);
  if (!session.hasSignIn || state.name !== "signed_in") {
    return null;
  }
  return (
    <p className="account-bar">
      <span>{state.emailAddress}</span>
      <button type="button" className="quiet-button" onClick={() => void session.signOut()}>
        Sign out
      </button>
    </p>
  );
}
