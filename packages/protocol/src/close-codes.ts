/**
 * WebSocket close codes the control plane uses to tell a peer why it ended
 * the connection, so the peer can decide whether reconnecting makes sense.
 * The WebSocket protocol reserves 4000 to 4999 for applications:
 * https://www.rfc-editor.org/rfc/rfc6455#section-7.4.2
 *
 * A peer the control plane refuses outright (wrong path, wrong protocol
 * version, bad credentials) never gets a WebSocket at all: the upgrade request
 * is answered with an ordinary HTTP error status instead.
 */
export const closeCodes = {
  /** The peer sent a frame that is not a valid message. Reconnecting will not help. */
  invalidMessage: 4400,
  /**
   * The client did not read fast enough and was dropped so it could not hold
   * up other viewers. It should reconnect with its last seen sequence.
   */
  clientTooSlow: 4408,
  /**
   * Another supervisor connected for the same thread, and the newest one
   * wins. The superseded supervisor must not reconnect, or the two would
   * keep displacing each other.
   */
  supersededByNewerSupervisor: 4409,
} as const;

export type CloseCode = (typeof closeCodes)[keyof typeof closeCodes];
