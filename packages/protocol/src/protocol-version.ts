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
 * - 3: working with a Git repository: `prepare_workspace` after the
 *   welcome, repository credential requests and answers, publication
 *   bundles, and the repository's thread events (the clone's travel as
 *   numbered supervisor events). The same increment covers
 *   `send_user_message` gaining the client's `messageId`, and
 *   `client_message_rejected` the identifier of the message it refuses,
 *   which came in alongside it (and alone would have needed no increment:
 *   a reload brings the web client up to date with its control plane).
 * - 4: each user's own model access: `configure_model_access` after
 *   `prepare_workspace` and whenever the thread's model or its owner's key
 *   changes, in place of a model and keys in the sandbox's environment; and
 *   `errorKind` on errored assistant messages.
 * - 5: the live desktop: the desktop viewer and desktop stream endpoints,
 *   `open_desktop_stream`, `desktop_control`, `desktop_availability` and
 *   `desktop_stream_failed` between control plane and supervisor, and
 *   `desktop_control_status` to clients (see `desktop-messages.ts`).
 */
export const protocolVersion = 5;
