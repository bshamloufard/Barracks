/**
 * Version of the messages exchanged between clients, the control plane and
 * sandbox supervisors. These parts are deployed independently (a running
 * sandbox can outlive a control plane release), so peers need a way to tell
 * whether they speak the same protocol. Increment it whenever a message
 * changes in a way an older peer could not safely understand.
 */
export const protocolVersion = 1;
