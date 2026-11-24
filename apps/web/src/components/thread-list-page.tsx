import type { ThreadSummary } from "@barrack/protocol";
import { useState } from "react";
import { settingsAddress, threadPageAddress } from "../page-address";
import {
  describeSandboxState,
  describeTimeSince,
  threadNameOf,
} from "../presentation/describe-sandbox";
import { useThreadList } from "../thread-list/use-thread-list";
import { AccountBar } from "./account-bar";
import { NewThreadForm } from "./new-thread-form";

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ThreadListPage() {
  const { state, reloadThreads, createThreadAndOpenIt } = useThreadList();
  const { list } = state;
  const [isFormOpen, setIsFormOpen] = useState(false);
  return (
    <div className="page">
      <header className="page-header thread-list-header">
        <h1>Barrack</h1>
        <AccountBar />
        <a href={settingsAddress}>Settings</a>
        <button
          type="button"
          className="primary-button"
          disabled={isFormOpen}
          onClick={() => setIsFormOpen(true)}
        >
          New thread
        </button>
      </header>
      <main>
        {isFormOpen && (
          <NewThreadForm
            isCreating={state.isCreatingThread}
            onCreate={createThreadAndOpenIt}
            onCancel={() => setIsFormOpen(false)}
          />
        )}
        {state.creationFailureReason !== undefined && (
          <p className="error-notice" role="alert">
            {state.creationFailureReason}
          </p>
        )}
        {list.name === "loading" && <p className="quiet-note">Loading threads…</p>}
        {list.name === "failed" && (
          <div className="error-notice rejection" role="alert">
            <span>{list.reason}</span>
            <button type="button" className="quiet-button" onClick={reloadThreads}>
              Try again
            </button>
          </div>
        )}
        {list.name === "loaded" && <ThreadList threads={list.threads} />}
      </main>
    </div>
  );
}

/** The last two parts of a repository's address, such as `owner/name`. */
function describeRepository(url: string): string {
  return url
    .replace(/\.git$/, "")
    .split("/")
    .slice(-2)
    .join("/");
}

function ThreadList({ threads }: { threads: ThreadSummary[] }) {
  if (threads.length === 0) {
    return <p className="quiet-note">No threads yet. Create one to give an agent a task.</p>;
  }
  const now = new Date();
  return (
    <ul className="thread-list">
      {threads.map((thread) => (
        <li key={thread.threadId}>
          <a className="thread-list-item" href={threadPageAddress(thread.threadId)}>
            <span className="thread-list-name">{threadNameOf(thread)}</span>
            <span className="thread-list-details">
              <span className={`sandbox-state sandbox-state-${thread.sandbox.state}`}>
                {describeSandboxState(thread.sandbox)}
              </span>
              {thread.isAgentWorking && <span className="agent-working">Agent working</span>}
              {thread.repository !== null && (
                <code className="thread-list-repository">
                  {describeRepository(thread.repository.url)}
                </code>
              )}
              <time
                dateTime={thread.lastActiveAt}
                title={`Last active ${dateTimeFormat.format(new Date(thread.lastActiveAt))}`}
              >
                Active {describeTimeSince(thread.lastActiveAt, now)}
              </time>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
