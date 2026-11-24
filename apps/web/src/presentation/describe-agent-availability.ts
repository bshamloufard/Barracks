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
 * A supervisor connected while the record still says the sandbox is
 * stopped or waking means the record is a moment old (a sandbox can wake in
 * under a second), and the live connection is believed.
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
    case "stopping":
      return { name: "stopping" };
    case "deleting":
      return { name: "deleting" };
    default:
      break;
  }
  if (state.isSupervisorConnected) {
    return { name: "connected" };
  }
  switch (sandbox.state) {
    case "starting":
      return { name: "waking" };
    case "stopped":
      return { name: "stopped" };
    case "creating":
      return { name: "starting" };
    default:
      return state.hasSeenSupervisorConnected ? { name: "not_connected" } : { name: "starting" };
  }
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

/**
 * What the conversation says under a message the agent has not been handed
 * yet. It waits for the agent; when nothing will bring the agent back by
 * itself (its sandbox is stopped, say, after a wake failed), it says what
 * the user can do, since a page opened later shows the message waiting
 * with no other explanation.
 */
export function describeWaitingMessage(state: ThreadState): string {
  const availability = describeAgentAvailability(state);
  switch (availability.name) {
    case "stopped":
      return "Waiting for the agent, whose sandbox is stopped. Resume the thread to deliver this message.";
    case "sandbox_failed":
      return availability.canResume
        ? "Waiting for the agent, whose sandbox failed. Resume the thread to deliver this message."
        : "Not delivered: this thread's sandbox is gone, so no agent will receive this message.";
    default:
      return "Waiting for the agent: it will receive this message as soon as it is connected.";
  }
}
