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
  /**
   * The peer sent a frame that is not a valid message, or a valid one that
   * breaks the protocol (a supervisor speaking before its hello, skipping an
   * event number, or claiming a delivery its thread's history contradicts).
   * Reconnecting with the same behaviour will not help.
   */
  invalidMessage: 4400,
  /**
   * The client did not authenticate: its first message was something other
   * than `authenticate`, its token was not valid, or a later token was for a
   * different user. Reconnecting with the same token will not help; the user
   * should sign in again. (A client that sent nothing in time is told
   * `authenticationTimedOut` instead.)
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
   * No `authenticate` message arrived in the time allowed after the upgrade.
   * Nothing is wrong with the user's sign-in (the client may have been slow
   * to send, or its network slow to carry it), so the client should
   * reconnect, with backoff, rather than ask the user to sign in again.
   */
  authenticationTimedOut: 4405,
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
  /**
   * A desktop viewer cannot be shown the desktop now; the
   * `desktop_unavailable` message sent just before says why, and whether
   * trying again can help.
   */
  desktopUnavailable: 4410,
  /**
   * The sandbox's end of a desktop stream ended: the sandbox is stopping, or
   * its desktop is restarting. The viewer may connect again, which tells it
   * whether the desktop is back.
   */
  desktopStreamEnded: 4411,
} as const;

export type CloseCode = (typeof closeCodes)[keyof typeof closeCodes];
