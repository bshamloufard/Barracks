import { useThread } from "../use-thread";
import { Conversation } from "./conversation";
import { MessageComposer } from "./message-composer";
import { StatusLine } from "./status-line";

export function ThreadView({ threadId }: { threadId: string }) {
  const { state, sendUserMessage, interruptAgent, dismissRejection } = useThread(threadId);
  return (
    <div className="page">
      <header className="page-header">
        <h1>
          Barrack <span className="thread-name">{threadId}</span>
        </h1>
        <StatusLine state={state} />
      </header>
      <main>
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
