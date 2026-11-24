/**
 * Version of the messages exchanged between clients, the control plane and
 * sandbox supervisors. These parts are deployed independently (a running
 * sandbox can outlive a control plane release), so peers need a way to tell
 * whether they speak the same protocol. Increment it whenever a message
 * changes in a way an older peer could not safely understand.
 *
 * Both WebSocket URLs carry it. The control plane refuses an upgrade naming
 * any other version with HTTP 400 and a body saying which version it
 * expected, and a supervisor treats that refusal as final: it exits with
 * the body as its reason.
 *
 * - 1: unacknowledged messages.
 * - 2: acknowledged delivery between supervisor and control plane (a hello
 *   and welcome, numbered agent events, user messages carrying their
 *   sequence), and the user message delivery status sent to clients; and
 *   clients authenticating with an `authenticate` first message. Both came
 *   in together, before any version 1 peer was deployed, so one increment
 *   covers them.
 *
 * `send_user_message` later gained the client's `messageId`, and
 * `client_message_rejected` the identifier of the message it refuses,
 * without an increment: they pass only between the control plane and the
 * web client it serves, which a reload brings up to date, and an increment
 * would also have turned away every running supervisor, which neither
 * change touches.
 */
export const protocolVersion = 2;
