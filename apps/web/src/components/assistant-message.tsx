import type { AssistantMessageEndReason, ModelAccessErrorKind } from "@barrack/protocol";
import { settingsAddress } from "../page-address";
import { describeModelAccessError } from "../presentation/describe-model-access-error";
import type {
  AssistantMessageEntry,
  StreamingAssistantMessageEntry,
} from "../thread-state/thread-state";

/** Text still streaming in, shown with a marker so it is clearly unfinished. */
export function StreamingAssistantMessage({ entry }: { entry: StreamingAssistantMessageEntry }) {
  return (
    <div className="assistant-message assistant-message-streaming" aria-busy="true">
      {entry.blocks.map((block) => (
        <TextualBlock
          key={block.contentBlockIndex}
          blockType={block.contentBlockType}
          text={block.text}
        />
      ))}
    </div>
  );
}

/**
 * A completed message. Tool call blocks are not shown here, because each
 * call appears as its own tool execution row right after the message.
 */
export function AssistantMessage({ entry }: { entry: AssistantMessageEntry }) {
  return (
    <div className="assistant-message">
      {entry.content.map(
        (block, index) =>
          block.type !== "tool_call" && (
            // Content blocks have no identity of their own, and a recorded
            // message never changes, so their position is a stable key.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <TextualBlock key={index} blockType={block.type} text={block.text} />
          ),
      )}
      <EndReasonNote
        endReason={entry.endReason}
        errorMessage={entry.errorMessage}
        errorKind={entry.errorKind}
      />
    </div>
  );
}

/** A failure the user can act on: what happened, what to do, and the provider's own words. */
function ModelAccessErrorNote({
  errorKind,
  errorMessage,
}: {
  errorKind: ModelAccessErrorKind;
  errorMessage: string | undefined;
}) {
  const { what, nextStep, isFixedInSettings } = describeModelAccessError(errorKind);
  return (
    <div className="error-notice model-access-error" role="alert">
      <p>
        <strong>{what}</strong> {nextStep}{" "}
        {isFixedInSettings && <a href={settingsAddress}>Open Settings</a>}
      </p>
      {errorMessage !== undefined && (
        <p className="quiet-note">The provider said: {errorMessage}</p>
      )}
    </div>
  );
}

function TextualBlock({ blockType, text }: { blockType: "text" | "thinking"; text: string }) {
  if (blockType === "thinking") {
    return <Thinking text={text} />;
  }
  return <p className="assistant-text">{text}</p>;
}

/** Thinking is shown, but folded away by default so the answer stays easy to read. */
function Thinking({ text }: { text: string }) {
  return (
    <details className="thinking">
      <summary>Thinking</summary>
      <p className="thinking-text">{text}</p>
    </details>
  );
}

function EndReasonNote({
  endReason,
  errorMessage,
  errorKind,
}: {
  endReason: AssistantMessageEndReason;
  errorMessage: string | undefined;
  errorKind: ModelAccessErrorKind | undefined;
}) {
  switch (endReason) {
    case "errored":
      return errorKind === undefined ? (
        <p className="error-notice" role="alert">
          The model returned an error: {errorMessage}
        </p>
      ) : (
        <ModelAccessErrorNote errorKind={errorKind} errorMessage={errorMessage} />
      );
    case "interrupted":
      return <p className="quiet-note">Stopped because you interrupted the agent.</p>;
    case "length_limit_reached":
      return (
        <p className="quiet-note">Stopped because the reply reached the model's length limit.</p>
      );
    case "completed":
    case "tool_use_requested":
      return null;
  }
}
