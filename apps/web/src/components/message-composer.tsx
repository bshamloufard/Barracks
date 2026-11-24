import { maximumUserMessageLength } from "@barrack/protocol";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import type { ThreadState } from "../thread-state/thread-state";

type MessageComposerProperties = {
  state: ThreadState;
  onSendUserMessage: (text: string) => void;
  onInterruptAgent: () => void;
};

export function MessageComposer({
  state,
  onSendUserMessage,
  onInterruptAgent,
}: MessageComposerProperties) {
  const [draft, setDraft] = useState("");
  const blockedReason = describeWhySendingIsBlocked(state);
  const lengthProblem = describeLengthProblem(draft);
  const isDraftBlank = draft.trim() === "";
  const canSend = blockedReason === undefined && lengthProblem === undefined && !isDraftBlank;
  const canInterrupt = blockedReason === undefined && state.isAgentWorking;

  const send = () => {
    if (!canSend) {
      return;
    }
    onSendUserMessage(draft);
    setDraft("");
  };
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };
  // Enter sends and Shift+Enter starts a new line. Enter while an input
  // method is composing (for example Japanese or Chinese input) confirms the
  // composition instead, so it must not send.
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <form className="message-composer" onSubmit={handleSubmit}>
      <textarea
        aria-label="Message to the agent"
        placeholder="Message the agent. Enter sends, Shift+Enter adds a line."
        rows={3}
        value={draft}
        disabled={blockedReason !== undefined}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="composer-actions">
        <p className="quiet-note">{blockedReason ?? lengthProblem}</p>
        <button type="button" disabled={!canInterrupt} onClick={onInterruptAgent}>
          Interrupt
        </button>
        <button type="submit" className="primary-button" disabled={!canSend}>
          Send
        </button>
      </div>
    </form>
  );
}

function describeWhySendingIsBlocked(state: ThreadState): string | undefined {
  if (state.connection.name !== "connected") {
    return "Waiting for the connection to the control plane.";
  }
  if (!state.isSupervisorConnected) {
    return "The agent is not connected. Start its sandbox supervisor to send messages.";
  }
  return undefined;
}

/** Checked here so an over-long message is caught before the control plane refuses it. */
function describeLengthProblem(draft: string): string | undefined {
  if (draft.length <= maximumUserMessageLength) {
    return undefined;
  }
  return `Messages can be at most ${maximumUserMessageLength.toLocaleString()} characters; this one has ${draft.length.toLocaleString()}.`;
}
