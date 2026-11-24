import type { AgentEvent, DeliverUserMessage, StreamFragment } from "@barrack/protocol";

/**
 * The boundary around "an agent the supervisor can run". Everything a
 * harness reports is already in Barrack's vocabulary, so nothing outside a
 * harness's own folder knows which agent is behind it.
 *
 * Every `agent_run_started` a harness reports is followed by exactly one
 * `agent_run_settled` or `agent_failed`, whatever happens, because a thread's
 * status depends on runs ending:
 * - a run in progress when the harness is stopped settles as interrupted;
 * - an agent process that ends unexpectedly is reported as `agent_failed`,
 *   which ends the run in progress, if any.
 */
export interface AgentHarness {
  /**
   * Starts the agent and resolves once it is ready for input. A harness
   * reports an agent that will not start as an `agent_failed` event rather
   * than by rejecting, so the control plane hears about it.
   */
  start(): Promise<void>;

  /**
   * Hands the agent a user message. An idle agent starts working on it; a
   * busy one takes it up after its current step. Failures, including the
   * agent refusing the message, are reported as events.
   */
  deliverUserMessage(message: UserMessage): void;

  /**
   * Stops the current work and drops user messages the agent has not yet
   * started on. Resolves once the agent is idle.
   */
  interrupt(): Promise<void>;

  /**
   * Shuts the agent down for good, settling a run in progress as
   * interrupted. Resolves once its process has ended and every event has
   * been reported; user messages delivered after this are ignored.
   */
  stop(): Promise<void>;
}

export type UserMessage = Pick<DeliverUserMessage, "messageId" | "text">;

/** How a harness tells the supervisor what the agent did. */
export type AgentHarnessObserver = {
  onAgentEvent(event: AgentEvent): void;
  onStreamFragment(fragment: StreamFragment): void;
  /**
   * The agent's process ended. When it was not expected, the harness has
   * already sent `agent_failed`, and it starts the agent again on the next
   * user message.
   */
  onAgentProcessEnded(ending: AgentProcessEnding): void;
};

export type AgentProcessEnding = { wasExpected: boolean; description: string };
