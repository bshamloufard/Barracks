import { threadListAddress } from "../page-address";
import { describeWaitingMessage } from "../presentation/describe-agent-availability";
import { threadNameOf } from "../presentation/describe-sandbox";
import { useThread } from "../use-thread";
import { AccountBar } from "./account-bar";
import { Conversation } from "./conversation";
import { MessageComposer } from "./message-composer";
import { RepositoryPanel } from "./repository-panel";
import { SandboxControls } from "./sandbox-controls";
import { StatusLine } from "./status-line";
import { UnconfirmedUserMessages } from "./unconfirmed-user-messages";

export function ThreadView({ threadId }: { threadId: string }) {
  const controls = useThread(threadId);
  const { state } = controls;
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
          <span className="thread-name">
            {record.name === "found" ? threadNameOf(record.thread) : ""}
          </span>
        </h1>
        <StatusLine state={state} />
        <AccountBar />
        {record.name === "found" && (
          <SandboxControls
            thread={record.thread}
            request={state.lifecycleRequest}
            onStop={controls.stopThread}
            onResume={controls.resumeThread}
            onRequestDeletion={controls.requestDeletion}
            onConfirmDeletion={controls.confirmDeletion}
            onCancelDeletion={controls.cancelDeletion}
          />
        )}
        {record.name === "found" && record.thread.repository !== null && (
          <RepositoryPanel thread={record.thread} repository={record.thread.repository} />
        )}
      </header>
      <main>
        <Conversation
          entries={state.entries}
          userMessagesDeliveredThroughSequence={state.userMessagesDeliveredThroughSequence}
          waitingNote={describeWaitingMessage(state)}
        />
        <UnconfirmedUserMessages
          messages={state.unconfirmedUserMessages}
          canSend={state.connection.name === "connected"}
          onSendAgain={controls.sendUserMessageAgain}
          onDiscard={controls.discardUserMessage}
        />
      </main>
      <footer className="page-footer">
        {state.rejectionReason !== undefined && (
          <div className="error-notice rejection" role="alert">
            <span>{state.rejectionReason}</span>
            <button type="button" className="quiet-button" onClick={controls.dismissRejection}>
              Dismiss
            </button>
          </div>
        )}
        <MessageComposer
          state={state}
          onSendUserMessage={controls.sendUserMessage}
          onInterruptAgent={controls.interruptAgent}
        />
      </footer>
    </div>
  );
}
