import type { AgentEvent } from "@barrack/protocol";

/** Small, valid agent events for tests that care about order rather than content. */

export const agentRunStarted: AgentEvent = { type: "agent_run_started" };

export const agentRunSettled: AgentEvent = { type: "agent_run_settled", wasInterrupted: false };

export function completedAssistantMessage(messageId: string, text: string): AgentEvent {
  return {
    type: "assistant_message",
    messageId,
    content: [{ type: "text", text }],
    endReason: "completed",
  };
}

export function toolExecutionStarted(toolCallId: string): AgentEvent {
  return {
    type: "tool_execution_started",
    toolCallId,
    toolName: "bash",
    arguments: { command: "ls" },
  };
}
