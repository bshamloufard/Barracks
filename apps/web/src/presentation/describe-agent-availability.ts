import type { ThreadState } from "../thread-state/thread-state";

/**
 * Whether the thread's agent can be talked to, put for the user. Two
 * sources decide it: the thread's record says whether its sandbox exists
 * yet, and the live connection says whether the supervisor inside it is
 * connected right now.
 */
export type AgentAvailability =
  | { name: "loading" }
  | { name: "starting" }
  | { name: "sandbox_failed"; reason: string }
  | { name: "connected" }
  | { name: "not_connected" };

/**
 * A sandbox that exists but whose supervisor this page has not yet seen
 * connect is still starting as far as the user can tell (a container takes
 * a few seconds to boot). Once it has connected, its absence means it went
 * away.
 */
export function describeAgentAvailability(state: ThreadState): AgentAvailability {
  const { record } = state;
  if (record.name !== "found") {
    return { name: "loading" };
  }
  if (record.sandbox.state === "failed") {
    return { name: "sandbox_failed", reason: record.sandbox.reason };
  }
  if (state.isSupervisorConnected) {
    return { name: "connected" };
  }
  if (record.sandbox.state === "creating" || !state.hasSeenSupervisorConnected) {
    return { name: "starting" };
  }
  return { name: "not_connected" };
}

/** Why the message box is closed, or undefined when the user can send. */
export function describeWhySendingIsBlocked(state: ThreadState): string | undefined {
  if (state.connection.name !== "connected") {
    return "Waiting for the connection to the control plane.";
  }
  const availability = describeAgentAvailability(state);
  switch (availability.name) {
    case "connected":
      return undefined;
    case "loading":
      return "Loading the thread.";
    case "starting":
      return "The thread's sandbox is starting; you can send messages once its agent connects.";
    case "sandbox_failed":
      return "This thread's sandbox could not be created, so it has no agent to send messages to.";
    case "not_connected":
      return "The agent is not connected.";
  }
}
