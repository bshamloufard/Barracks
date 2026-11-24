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
 *   sequence), and the user message delivery status sent to clients.
 */
export const protocolVersion = 2;
