/**
 * WebSocket close codes the control plane uses to tell a peer why it ended
 * the connection, so the peer can decide whether reconnecting makes sense.
 * The WebSocket protocol reserves 4000 to 4999 for applications:
 * https://www.rfc-editor.org/rfc/rfc6455#section-7.4.2
 *
 * A peer the control plane refuses outright (wrong path, wrong protocol
 * version, a disallowed origin, a supervisor's bad token) never gets a
 * WebSocket at all: the upgrade request is answered with an ordinary HTTP
 * error status instead. A client proves who it is only after the upgrade, in
 * its first message, so what follows from that is told with the codes below.
 */
export const closeCodes = {
  /** The peer sent a frame that is not a valid message. Reconnecting will not help. */
  invalidMessage: 4400,
  /**
   * The client did not authenticate: its first message was something other
   * than `authenticate`, none came in time, its token was not valid, or a
   * later token was for a different user. Reconnecting with the same token
   * will not help; the user should sign in again.
   */
  notAuthenticated: 4401,
  /**
   * The newest access token the client sent expired, and no newer one
   * arrived. The client should get a fresh token (refreshing its session)
   * and reconnect with its last seen sequence, which loses nothing.
   */
  accessTokenExpired: 4402,
  /**
   * The user signed in, but this installation does not let them use it
   * (their email address is not on its allow list). Reconnecting will not
   * help.
   */
  userNotAllowed: 4403,
  /**
   * There is no thread with this identifier that the user may see. A thread
   * that exists but belongs to someone else is answered exactly the same way.
   */
  threadNotFound: 4404,
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
