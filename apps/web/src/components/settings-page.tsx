import type { GithubConnection } from "@barrack/protocol";
import { useCallback, useEffect, useState } from "react";
import { useSession } from "../authentication/session-context";
import { threadListAddress } from "../page-address";
import { AccountBar } from "./account-bar";
import { ModelAccessSettings } from "./model-access-settings";
import { ModelUsageSettings } from "./model-usage-settings";

type ConnectionView =
  | { name: "loading" }
  | { name: "loaded"; connection: GithubConnection }
  | { name: "failed"; reason: string };

/**
 * The user's settings: their own model keys, on which their threads run,
 * what those threads have used and the cap on it, and their link to GitHub, through which their threads can work on their
 * private repositories and publish their work.
 */
export function SettingsPage() {
  const { repositoriesApi } = useSession();
  const [view, setView] = useState<ConnectionView>({ name: "loading" });
  const [isBusy, setIsBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    repositoriesApi.readGithubConnection().then(
      (connection) => setView({ name: "loaded", connection }),
      (error: unknown) => setView({ name: "failed", reason: describeError(error) }),
    );
  }, [repositoriesApi]);

  useEffect(load, [load]);

  const connect = () => {
    setIsBusy(true);
    setActionFailure(undefined);
    repositoriesApi.startConnectingGithub().then(
      (authorizationUrl) => window.location.assign(authorizationUrl),
      (error: unknown) => {
        setIsBusy(false);
        setActionFailure(describeError(error));
      },
    );
  };

  const disconnect = () => {
    setIsBusy(true);
    setActionFailure(undefined);
    repositoriesApi.disconnectGithub().then(
      (connection) => {
        setIsBusy(false);
        setView({ name: "loaded", connection });
      },
      (error: unknown) => {
        setIsBusy(false);
        setActionFailure(describeError(error));
      },
    );
  };

  return (
    <div className="page">
      <header className="page-header thread-list-header">
        <h1>
          <a href={threadListAddress} className="home-link">
            Barrack
          </a>{" "}
          <span className="thread-name">Settings</span>
        </h1>
        <AccountBar />
      </header>
      <main>
        <section className="settings-section" aria-labelledby="model-access-heading">
          <h2 id="model-access-heading">Model access</h2>
          <ModelAccessSettings />
        </section>
        <section className="settings-section" aria-labelledby="model-usage-heading">
          <h2 id="model-usage-heading">Model usage</h2>
          <ModelUsageSettings />
        </section>
        <section className="settings-section" aria-labelledby="github-heading">
          <h2 id="github-heading">GitHub</h2>
          {actionFailure !== undefined && (
            <p className="error-notice" role="alert">
              {actionFailure}
            </p>
          )}
          {view.name === "loading" && <p className="quiet-note">Loading…</p>}
          {view.name === "failed" && (
            <p className="error-notice" role="alert">
              {view.reason}
            </p>
          )}
          {view.name === "loaded" && (
            <GithubConnectionView
              connection={view.connection}
              isBusy={isBusy}
              onConnect={connect}
              onDisconnect={disconnect}
            />
          )}
        </section>
      </main>
    </div>
  );
}

function GithubConnectionView({
  connection,
  isBusy,
  onConnect,
  onDisconnect,
}: {
  connection: GithubConnection;
  isBusy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  switch (connection.state) {
    case "unavailable":
      return <p className="sandbox-banner sandbox-banner-warning">{connection.reason}</p>;
    case "not_connected":
      return (
        <>
          <p>
            Connect your GitHub account to start threads on your private repositories and publish
            what the agent does there as a branch or a pull request. Barrack's GitHub App must be
            installed on those repositories: <a href={connection.installUrl}>install it</a>, then
            connect.
          </p>
          <div className="sandbox-actions">
            <button type="button" className="primary-button" disabled={isBusy} onClick={onConnect}>
              {isBusy ? "Connecting…" : "Connect GitHub"}
            </button>
          </div>
        </>
      );
    case "connected":
      return (
        <>
          <p>
            Connected as <strong>@{connection.login}</strong>. Threads can work on these
            repositories, which you can push to and Barrack's App is installed on:
          </p>
          {connection.repositories.length === 0 ? (
            <p className="quiet-note">
              None yet. <a href={connection.installUrl}>Install Barrack's App</a> on a repository,
              then connect again.
            </p>
          ) : (
            <ul className="linked-repositories">
              {connection.repositories.map((repository) => (
                <li key={repository.fullName}>
                  <code>{repository.fullName}</code>
                  {repository.isPrivate && <span className="quiet-note"> private</span>}
                </li>
              ))}
            </ul>
          )}
          <div className="sandbox-actions">
            <button type="button" disabled={isBusy} onClick={onConnect}>
              Connect again to refresh
            </button>
            <a href={connection.installUrl}>Install on more repositories</a>
            <button
              type="button"
              className="danger-button"
              disabled={isBusy}
              onClick={onDisconnect}
            >
              Disconnect
            </button>
          </div>
        </>
      );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
