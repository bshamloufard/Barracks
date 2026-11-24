import { useRef } from "react";
import { type ConversationEntry, isWaitingForAgent } from "../thread-state/thread-state";
import { AssistantMessage, StreamingAssistantMessage } from "./assistant-message";
import { ToolExecution } from "./tool-execution";
import { useStickToBottom } from "./use-stick-to-bottom";

export function Conversation({
  entries,
  userMessagesDeliveredThroughSequence,
}: {
  entries: ConversationEntry[];
  userMessagesDeliveredThroughSequence: number | undefined;
}) {
  const conversationReference = useRef<HTMLDivElement>(null);
  useStickToBottom(conversationReference);
  return (
    <div ref={conversationReference}>
      {entries.length === 0 ? (
        <p className="quiet-note">Nothing here yet. Send the agent a message to start.</p>
      ) : (
        <ol className="conversation">
          {entries.map((entry) => (
            <li key={entry.key} className="conversation-entry">
              <ConversationEntryView
                entry={entry}
                userMessagesDeliveredThroughSequence={userMessagesDeliveredThroughSequence}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ConversationEntryView({
  entry,
  userMessagesDeliveredThroughSequence,
}: {
  entry: ConversationEntry;
  userMessagesDeliveredThroughSequence: number | undefined;
}) {
  switch (entry.kind) {
    case "user_message":
      return (
        <>
          <p className="user-message">{entry.text}</p>
          {isWaitingForAgent(userMessagesDeliveredThroughSequence, entry) && (
            <p className="quiet-note">
              Waiting for the agent: it will receive this message as soon as it is connected.
            </p>
          )}
        </>
      );
    case "streaming_assistant_message":
      return <StreamingAssistantMessage entry={entry} />;
    case "assistant_message":
      return <AssistantMessage entry={entry} />;
    case "tool_execution":
      return <ToolExecution entry={entry} />;
    case "agent_failed":
      return (
        <p className="error-notice" role="alert">
          The agent stopped working: {entry.errorMessage}
        </p>
      );
    case "agent_interrupted":
      return <p className="quiet-note">Interrupted.</p>;
  }
}
