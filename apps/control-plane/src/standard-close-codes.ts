/**
 * Close codes defined by the WebSocket protocol itself, as opposed to
 * Barrack's own `closeCodes`: https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1
 */
export const standardCloseCodes = {
  /** The server is shutting down; the peer may reconnect to its replacement. */
  goingAway: 1001,
  /** The server hit a condition it could not handle. */
  internalError: 1011,
  /** The server cannot serve the request just now, through no fault of the peer's. */
  tryAgainLater: 1013,
} as const;
