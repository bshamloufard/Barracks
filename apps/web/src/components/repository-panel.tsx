import type { ThreadRepositorySummary, ThreadSummary } from "@barrack/protocol";
import { useState } from "react";
import { useSession } from "../authentication/session-context";

type PublishingRequest =
  | { name: "idle" }
  | { name: "sending"; openPullRequest: boolean }
  | { name: "failed"; reason: string };

/**
 * The thread's repository, and publishing what the agent committed on its
 * branch: pushing the branch, and opening a pull request for it. Where
 * publishing is not available (a public repository Barrack cannot write
 * to), the panel says why instead of offering a button that would fail.
 * The outcome of every publication is also recorded in the conversation.
 */
export function RepositoryPanel({
  thread,
  repository,
}: {
  thread: ThreadSummary;
  repository: ThreadRepositorySummary;
}) {
  const { repositoriesApi } = useSession();
  const [request, setRequest] = useState<PublishingRequest>({ name: "idle" });
  const { publishing } = repository;
  const isSending = request.name === "sending";

  const publish = (openPullRequest: boolean) => {
    setRequest({ name: "sending", openPullRequest });
    repositoriesApi.publishThread(thread.threadId, openPullRequest).then(
      () => setRequest({ name: "idle" }),
      (error: unknown) =>
        setRequest({
          name: "failed",
          reason: error instanceof Error ? error.message : String(error),
        }),
    );
  };

  return (
    <section className="repository-panel" aria-label="Repository">
      <p className="repository-summary">
        <code>{repository.url}</code>{" "}
        <span className="quiet-note">
          {repository.baseBranch ?? "default branch"} → {repository.workBranch}
        </span>
      </p>
      {publishing.isAvailable ? (
        <div className="sandbox-actions">
          <button
            type="button"
            disabled={isSending || thread.sandbox.state !== "running"}
            onClick={() => publish(false)}
          >
            {request.name === "sending" && !request.openPullRequest ? "Pushing…" : "Push branch"}
          </button>
          {publishing.pullRequestUrl === null ? (
            <button
              type="button"
              disabled={isSending || thread.sandbox.state !== "running"}
              onClick={() => publish(true)}
            >
              {request.name === "sending" && request.openPullRequest
                ? "Opening…"
                : "Open pull request"}
            </button>
          ) : (
            <a href={publishing.pullRequestUrl} target="_blank" rel="noreferrer">
              Pull request
            </a>
          )}
          {thread.sandbox.state !== "running" && (
            <span className="quiet-note">The sandbox must be running to publish.</span>
          )}
        </div>
      ) : (
        <p className="quiet-note publishing-unavailable">
          Publishing is not available: {publishing.reason}
        </p>
      )}
      {request.name === "failed" && (
        <p className="error-notice" role="alert">
          {request.reason}
        </p>
      )}
    </section>
  );
}
