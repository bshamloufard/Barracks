import { useState } from "react";
import { threadListAddress } from "../page-address";
import { describeWaitingMessage } from "../presentation/describe-agent-availability";
import { threadNameOf } from "../presentation/describe-sandbox";
import { useThread } from "../use-thread";
import { AccountBar } from "./account-bar";
import { Conversation } from "./conversation";
import { DesktopPanel } from "./desktop-panel";
import { MessageComposer } from "./message-composer";
import { RepositoryPanel } from "./repository-panel";
import { SandboxControls } from "./sandbox-controls";
import { StatusLine } from "./status-line";
import { ThreadModelPanel } from "./thread-model-panel";
import { UnconfirmedUserMessages } from "./unconfirmed-user-messages";

type ModelSwitch = { name: "idle" } | { name: "switching" } | { name: "failed"; reason: string };

export function ThreadView({ threadId }: { threadId: string }) {
  const controls = useThread(threadId);
  const { state } = controls;
  const [modelSwitch, setModelSwitch] = useState<ModelSwitch>({ name: "idle" });
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
        {record.name === "found" && (
          <ThreadModelPanel
            thread={record.thread}
            isSwitching={modelSwitch.name === "switching"}
            switchFailure={modelSwitch.name === "failed" ? modelSwitch.reason : undefined}
            onSwitch={(model) => {
              setModelSwitch({ name: "switching" });
              controls.switchModel(model).then(
                () => setModelSwitch({ name: "idle" }),
                (error: unknown) =>
                  setModelSwitch({
                    name: "failed",
                    reason: error instanceof Error ? error.message : String(error),
                  }),
              );
            }}
          />
        )}
        {record.name === "found" && record.thread.repository !== null && (
          <RepositoryPanel thread={record.thread} repository={record.thread.repository} />
        )}
      </header>
      {record.name === "found" && (
        <DesktopPanel
          thread={record.thread}
          controllingViewerId={state.desktopControllingViewerId}
          isWaking={
            state.lifecycleRequest.name === "sending" && state.lifecycleRequest.action === "resume"
          }
          onWake={controls.resumeThread}
        />
      )}
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
