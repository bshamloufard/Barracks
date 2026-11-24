import type { AgentEvent, DeliverUserMessage, StreamFragment } from "@barrack/protocol";

/**
 * The boundary around "an agent the supervisor can run". Everything a
 * harness reports is already in Barrack's vocabulary, so nothing outside a
 * harness's own folder knows which agent is behind it.
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

  /** Shuts the agent down for good. Resolves once its process has ended. */
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
