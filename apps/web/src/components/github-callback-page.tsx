import { useEffect, useRef, useState } from "react";
import { useSession } from "../authentication/session-context";
import { settingsAddress } from "../page-address";

/**
 * Where GitHub sends the user back after they approve Barrack's App. The
 * code and state in the address are handed to the control plane with the
 * signed-in user's own token, which is what proves the user finishing is
 * the one who started; then the address is cleared and the user goes back
 * to Settings.
 */
export function GithubCallbackPage({ code, state }: { code: string; state: string }) {
  const { repositoriesApi } = useSession();
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const hasSent = useRef(false);

  useEffect(() => {
    // A state is used once; React's development mode runs effects twice.
    if (hasSent.current) {
      return;
    }
    hasSent.current = true;
    repositoriesApi.finishConnectingGithub(code, state).then(
      () => window.location.replace(settingsAddress),
      (error: unknown) => setFailure(error instanceof Error ? error.message : String(error)),
    );
  }, [repositoriesApi, code, state]);

  return (
    <main className="page">
      {failure === undefined ? (
        <p className="quiet-note">Connecting your GitHub account…</p>
      ) : (
        <p className="error-notice" role="alert">
          {failure} <a href={settingsAddress}>Back to Settings</a>
        </p>
      )}
    </main>
  );
}
