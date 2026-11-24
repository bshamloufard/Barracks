import type { ThreadState } from "../thread-state/thread-state";

/**
 * Whether the thread's agent can be talked to, put for the user. Two
 * sources decide it: the thread's record says what its sandbox is doing,
 * and the live connection says whether the supervisor inside it is
 * connected right now.
 */
export type AgentAvailability =
  | { name: "loading" }
  | { name: "starting" }
  | { name: "waking" }
  | { name: "stopping" }
  | { name: "stopped" }
  | { name: "sandbox_failed"; reason: string; canResume: boolean }
  | { name: "deleting" }
  | { name: "connected" }
  | { name: "not_connected" };

/**
 * A running sandbox whose supervisor this page has not yet seen connect is
 * still starting as far as the user can tell (a container takes a few
 * seconds to boot). Once it has connected, its absence means it went away.
 */
export function describeAgentAvailability(state: ThreadState): AgentAvailability {
  const { record } = state;
  if (record.name !== "found") {
    return { name: "loading" };
  }
  const { sandbox } = record.thread;
  switch (sandbox.state) {
    case "failed":
      return { name: "sandbox_failed", reason: sandbox.reason, canResume: sandbox.canResume };
    case "starting":
      return { name: "waking" };
    case "stopping":
      return { name: "stopping" };
    case "stopped":
      return { name: "stopped" };
    case "deleting":
      return { name: "deleting" };
    default:
      break;
  }
  if (state.isSupervisorConnected) {
    return { name: "connected" };
  }
  if (sandbox.state === "creating" || !state.hasSeenSupervisorConnected) {
    return { name: "starting" };
  }
  return { name: "not_connected" };
}

/**
 * Why the message box is closed, or undefined when the user can send. A
 * message can be sent while the agent is starting, away or stopped: it is
 * recorded and waits for the agent (waking a stopped sandbox), and the
 * conversation shows it waiting.
 */
export function describeWhySendingIsBlocked(state: ThreadState): string | undefined {
  if (state.connection.name !== "connected") {
    return "Waiting for the connection to the control plane.";
  }
  const availability = describeAgentAvailability(state);
  switch (availability.name) {
    case "loading":
      return "Loading the thread.";
    case "sandbox_failed":
      return availability.canResume
        ? "This thread's sandbox failed. Resume it to send messages again."
        : "This thread's sandbox is gone, so it has no agent to send messages to.";
    case "deleting":
      return "This thread is being deleted.";
    default:
      return undefined;
  }
}
