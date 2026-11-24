import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./agent-events.js";
import { maximumIdentifierLength, maximumToolOutputLength } from "./limits.js";
import {
  type ControlPlaneToSupervisorMessage,
  parseControlPlaneToSupervisorMessage,
  parseSupervisorToControlPlaneMessage,
  type SupervisorToControlPlaneMessage,
} from "./supervisor-messages.js";

const everyAgentEvent: AgentEvent[] = [
  { type: "agent_run_started" },
  {
    type: "assistant_message",
    messageId: "assistant-1",
    content: [
      { type: "thinking", text: "The user wants a greeting." },
      { type: "text", text: "Running it." },
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "bash",
        arguments: { command: "echo hi", timeoutSeconds: 10, env: null, flags: ["-e"] },
      },
    ],
    endReason: "tool_use_requested",
  },
  {
    type: "assistant_message",
    messageId: "assistant-2",
    content: [],
    endReason: "errored",
    errorMessage: "401: Incorrect API key provided",
  },
  {
    type: "tool_execution_started",
    toolCallId: "call-1",
    toolName: "bash",
    arguments: { command: "echo hi" },
  },
  {
    type: "tool_execution_finished",
    toolCallId: "call-1",
    toolName: "bash",
    isError: false,
    output: { text: "hi\n", isTruncated: false, originalSizeInBytes: 3 },
    durationInMilliseconds: 8,
  },
  {
    type: "tool_execution_finished",
    toolCallId: "call-2",
    toolName: "read",
    isError: true,
    output: { text: "No such file", isTruncated: false, originalSizeInBytes: 12 },
  },
  { type: "agent_run_settled", wasInterrupted: true },
  { type: "agent_failed", errorMessage: "The agent process exited with code 1." },
];

function frameOf(message: unknown): string {
  return JSON.stringify(message);
}

function supervisorRejectionOf(message: unknown): string {
  const result = parseSupervisorToControlPlaneMessage(frameOf(message));
  if (result.ok) {
    throw new Error(`Expected rejection, but parsed ${frameOf(result.value)}`);
  }
  return result.errorMessage;
}

describe("supervisor to control plane messages", () => {
  it.each(everyAgentEvent)("carry the $type agent event unchanged", (event) => {
    const message: SupervisorToControlPlaneMessage = { type: "agent_event", event };

    expect(parseSupervisorToControlPlaneMessage(frameOf(message))).toEqual({
      ok: true,
      value: message,
    });
  });

  it("carry an assistant text fragment unchanged", () => {
    const message: SupervisorToControlPlaneMessage = {
      type: "stream_fragment",
      fragment: {
        type: "assistant_text_fragment",
        messageId: "assistant-1",
        contentBlockIndex: 0,
        contentBlockType: "thinking",
        appendedText: "Hel",
      },
    };

    expect(parseSupervisorToControlPlaneMessage(frameOf(message))).toEqual({
      ok: true,
      value: message,
    });
  });

  it("cannot carry a user message, which only the control plane records", () => {
    const errorMessage = supervisorRejectionOf({
      type: "agent_event",
      event: { type: "user_message", messageId: "user-1", text: "Hello" },
    });

    expect(errorMessage).toContain("event.type");
  });

  it("reject an unknown message type and name the field", () => {
    expect(supervisorRejectionOf({ type: "agent_thought" })).toContain("→ at type");
  });

  it("reject an unknown event type", () => {
    expect(
      supervisorRejectionOf({ type: "agent_event", event: { type: "turn_started" } }),
    ).toContain("event.type");
  });

  it("reject properties the protocol does not define", () => {
    const errorMessage = supervisorRejectionOf({
      type: "agent_event",
      event: { type: "agent_run_settled", wasInterrupted: false, willRetry: false },
    });

    expect(errorMessage).toContain('Unrecognized key: "willRetry"');
  });

  it("reject an event with a missing field", () => {
    expect(
      supervisorRejectionOf({ type: "agent_event", event: { type: "agent_run_settled" } }),
    ).toContain("event.wasInterrupted");
  });

  it("reject an empty identifier", () => {
    const errorMessage = supervisorRejectionOf({
      type: "agent_event",
      event: { type: "assistant_message", messageId: "", content: [], endReason: "completed" },
    });

    expect(errorMessage).toContain("event.messageId");
  });

  it("reject an identifier longer than the limit", () => {
    const errorMessage = supervisorRejectionOf({
      type: "agent_event",
      event: {
        type: "tool_execution_started",
        toolCallId: "x".repeat(maximumIdentifierLength + 1),
        toolName: "bash",
        arguments: {},
      },
    });

    expect(errorMessage).toContain("event.toolCallId");
  });

  it("reject tool output the supervisor should have truncated", () => {
    const errorMessage = supervisorRejectionOf({
      type: "agent_event",
      event: {
        type: "tool_execution_finished",
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
        output: {
          text: "x".repeat(maximumToolOutputLength + 1),
          isTruncated: false,
          originalSizeInBytes: maximumToolOutputLength + 1,
        },
      },
    });

    expect(errorMessage).toContain("event.output.text");
  });

  it("reject tool arguments that are not a JSON object", () => {
    const errorMessage = supervisorRejectionOf({
      type: "agent_event",
      event: {
        type: "tool_execution_started",
        toolCallId: "call-1",
        toolName: "bash",
        arguments: ["echo hi"],
      },
    });

    expect(errorMessage).toContain("event.arguments");
  });

  it("reject an errored assistant message without an error message", () => {
    const errorMessage = supervisorRejectionOf({
      type: "agent_event",
      event: { type: "assistant_message", messageId: "a", content: [], endReason: "errored" },
    });

    expect(errorMessage).toContain("event.errorMessage");
  });

  it("reject an error message on an assistant message that did not error", () => {
    const errorMessage = supervisorRejectionOf({
      type: "agent_event",
      event: {
        type: "assistant_message",
        messageId: "a",
        content: [],
        endReason: "completed",
        errorMessage: "Request was aborted",
      },
    });

    expect(errorMessage).toContain("event.errorMessage");
  });

  it("reject a stream fragment with a negative content block index", () => {
    const errorMessage = supervisorRejectionOf({
      type: "stream_fragment",
      fragment: {
        type: "assistant_text_fragment",
        messageId: "assistant-1",
        contentBlockIndex: -1,
        contentBlockType: "text",
        appendedText: "Hel",
      },
    });

    expect(errorMessage).toContain("fragment.contentBlockIndex");
  });
});

describe("control plane to supervisor messages", () => {
  const everyMessage: ControlPlaneToSupervisorMessage[] = [
    { type: "deliver_user_message", messageId: "user-1", text: "Please say hello" },
    { type: "interrupt_agent" },
  ];

  it.each(everyMessage)("carry $type unchanged", (message) => {
    expect(parseControlPlaneToSupervisorMessage(frameOf(message))).toEqual({
      ok: true,
      value: message,
    });
  });

  it("reject a user message with no text", () => {
    const result = parseControlPlaneToSupervisorMessage(
      frameOf({ type: "deliver_user_message", messageId: "user-1", text: "" }),
    );

    expect(result).toEqual({ ok: false, errorMessage: expect.stringContaining("text") });
  });

  it("reject messages meant for the control plane", () => {
    const result = parseControlPlaneToSupervisorMessage(
      frameOf({ type: "agent_event", event: { type: "agent_run_started" } }),
    );

    expect(result.ok).toBe(false);
  });
});
