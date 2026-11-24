import type { UnconfirmedUserMessage } from "../thread-state/thread-state";

type UnconfirmedUserMessagesProperties = {
  messages: UnconfirmedUserMessage[];
  /** Sending is possible only while the page is connected. */
  canSend: boolean;
  onSendAgain: (messageId: string) => void;
  onDiscard: (messageId: string) => void;
};

/**
 * The user's messages the control plane has not yet confirmed, after the
 * conversation. Sending one again is always safe: it goes under the same
 * identifier, so the agent receives it once even if the first attempt was
 * recorded after all.
 */
export function UnconfirmedUserMessages(properties: UnconfirmedUserMessagesProperties) {
  const { messages, canSend } = properties;
  if (messages.length === 0) {
    return null;
  }
  return (
    <ol className="conversation">
      {messages.map((message) => (
        <li key={message.messageId} className="conversation-entry">
          <p className="user-message">{message.text}</p>
          {message.status === "sending" ? (
            <p className="quiet-note">Sending…</p>
          ) : (
            <div className="error-notice rejection" role="alert">
              <span>Not sent.</span>
              <button
                type="button"
                className="quiet-button"
                disabled={!canSend}
                onClick={() => properties.onSendAgain(message.messageId)}
              >
                Send again
              </button>
              <button
                type="button"
                className="quiet-button"
                onClick={() => properties.onDiscard(message.messageId)}
              >
                Discard
              </button>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
