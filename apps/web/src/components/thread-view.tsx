import { threadListAddress } from "../page-address";
import { useThread } from "../use-thread";
import { Conversation } from "./conversation";
import { MessageComposer } from "./message-composer";
import { StatusLine } from "./status-line";

export function ThreadView({ threadId }: { threadId: string }) {
  const { state, sendUserMessage, interruptAgent, dismissRejection } = useThread(threadId);
  if (state.record.name === "not_found") {
    return (
      <main className="page">
        <p className="error-notice">
          There is no thread “{threadId}”. <a href={threadListAddress}>See all threads</a>.
        </p>
      </main>
    );
  }
  const { record } = state;
  return (
    <div className="page">
      <header className="page-header">
        <h1>
          <a href={threadListAddress} className="home-link">
            Barrack
          </a>{" "}
          <span className="thread-name">{threadId}</span>
        </h1>
        <StatusLine state={state} />
      </header>
      <main>
        {record.name === "found" && record.sandbox.state === "failed" && (
          <p className="error-notice" role="alert">
            This thread's sandbox could not be created. {record.sandbox.reason}
          </p>
        )}
        <Conversation entries={state.entries} />
      </main>
      <footer className="page-footer">
        {state.rejectionReason !== undefined && (
          <div className="error-notice rejection" role="alert">
            <span>{state.rejectionReason}</span>
            <button type="button" className="quiet-button" onClick={dismissRejection}>
              Dismiss
            </button>
          </div>
        )}
        <MessageComposer
          state={state}
          onSendUserMessage={sendUserMessage}
          onInterruptAgent={interruptAgent}
        />
      </footer>
    </div>
  );
}
