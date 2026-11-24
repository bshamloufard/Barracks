import {
  type AgentEvent,
  type AssistantMessageEvent,
  maximumAgentEventFrameLength,
  parseSupervisorToControlPlaneMessage,
} from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import {
  fitAgentEventInFrame,
  measureAgentEventFrame,
  omittedArgumentsNoteKey,
} from "./fit-agent-event-in-frame.js";

const oversizedLength = maximumAgentEventFrameLength + 1_000_000;

function assistantMessage(content: AssistantMessageEvent["content"]): AssistantMessageEvent {
  return { type: "assistant_message", messageId: "message-1", content, endReason: "completed" };
}

/** What the control plane would make of the event's frame. */
function parseAsControlPlane(event: AgentEvent) {
  return parseSupervisorToControlPlaneMessage(
    JSON.stringify({ type: "agent_event", eventNumber: Number.MAX_SAFE_INTEGER, event }),
  );
}

describe("fitAgentEventInFrame", () => {
  it("leaves an event that fits in one frame unchanged", () => {
    const event = assistantMessage([{ type: "text", text: "Hello there." }]);

    expect(fitAgentEventInFrame(event)).toBe(event);
  });

  it("cuts the middle out of a message's text too long for one frame and says how much it left out", () => {
    const text = `START ${"x".repeat(oversizedLength)} END`;

    const fitted = fitAgentEventInFrame(assistantMessage([{ type: "text", text }]));

    expect(parseAsControlPlane(fitted).ok).toBe(true);
    expect(fitted).toMatchObject({ messageId: "message-1", endReason: "completed" });
    const [block] = fitted.type === "assistant_message" ? fitted.content : [];
    expect(block?.type === "text" && block.text.startsWith("START ")).toBe(true);
    expect(block?.type === "text" && block.text.endsWith(" END")).toBe(true);
    expect(block?.type === "text" ? block.text : "").toMatch(/\[… \d+ characters omitted …\]/);
  });

  it("replaces tool call arguments too large to record with a note, keeping the call itself", () => {
    const toolCall = {
      type: "tool_call" as const,
      toolCallId: "call-1",
      toolName: "write",
      arguments: { path: "big.txt", content: "x".repeat(oversizedLength) },
    };

    const fitted = fitAgentEventInFrame(
      assistantMessage([{ type: "text", text: "Writing the file." }, toolCall]),
    );

    expect(parseAsControlPlane(fitted).ok).toBe(true);
    expect(fitted).toMatchObject({
      content: [
        { type: "text", text: "Writing the file." },
        {
          type: "tool_call",
          toolCallId: "call-1",
          toolName: "write",
          arguments: { [omittedArgumentsNoteKey]: expect.stringContaining("too large to record") },
        },
      ],
    });
  });

  it("replaces the arguments of a tool execution too large to record with a note", () => {
    const fitted = fitAgentEventInFrame({
      type: "tool_execution_started",
      toolCallId: "call-1",
      toolName: "write",
      arguments: { content: "x".repeat(oversizedLength) },
    });

    expect(parseAsControlPlane(fitted).ok).toBe(true);
    expect(fitted).toEqual({
      type: "tool_execution_started",
      toolCallId: "call-1",
      toolName: "write",
      arguments: { [omittedArgumentsNoteKey]: expect.stringContaining("too large to record") },
    });
  });

  it("replaces the content of a message with too many blocks to cut usefully with a notice", () => {
    const blocks = Array.from({ length: 100 }, () => ({
      type: "text" as const,
      text: "y".repeat(200),
    }));
    const event: AssistantMessageEvent = {
      ...assistantMessage(blocks),
      endReason: "errored",
      errorMessage: "The provider failed.",
    };

    const fitted = fitAgentEventInFrame(event, 10_000);

    expect(measureAgentEventFrame(fitted)).toBeLessThanOrEqual(10_000);
    expect(fitted).toEqual({
      type: "assistant_message",
      messageId: "message-1",
      endReason: "errored",
      errorMessage: "The provider failed.",
      content: [{ type: "text", text: expect.stringContaining("its content was left out") }],
    });
  });

  it("falls back to a notice when cut text is still too large because JSON must escape it", () => {
    const controlCharacters = "\u0001".repeat(50_000);

    const fitted = fitAgentEventInFrame(
      assistantMessage([{ type: "text", text: controlCharacters }]),
      20_000,
    );

    expect(measureAgentEventFrame(fitted)).toBeLessThanOrEqual(20_000);
    expect(fitted).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("its content was left out") }],
    });
  });
});
