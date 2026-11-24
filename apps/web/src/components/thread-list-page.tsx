import type { ThreadSummary } from "@barrack/protocol";
import { threadPageAddress } from "../page-address";
import {
  describeSandboxState,
  describeTimeSince,
  threadNameOf,
} from "../presentation/describe-sandbox";
import { useThreadList } from "../thread-list/use-thread-list";
import { AccountBar } from "./account-bar";

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ThreadListPage() {
  const { state, reloadThreads, createThreadAndOpenIt } = useThreadList();
  const { list } = state;
  return (
    <div className="page">
      <header className="page-header thread-list-header">
        <h1>Barrack</h1>
        <AccountBar />
        <button
          type="button"
          className="primary-button"
          disabled={state.isCreatingThread}
          onClick={createThreadAndOpenIt}
        >
          {state.isCreatingThread ? "Creating…" : "New thread"}
        </button>
      </header>
      <main>
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
