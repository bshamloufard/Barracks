import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./agent-events.js";
import {
  type ClientToControlPlaneMessage,
  type ControlPlaneToClientMessage,
  measureLargestThreadEventFrame,
  parseClientToControlPlaneMessage,
  parseControlPlaneToClientMessage,
} from "./client-messages.js";
import {
  maximumAccessTokenLength,
  maximumAgentEventFrameLength,
  maximumErrorMessageLength,
  maximumFrameLength,
  maximumUserMessageLength,
} from "./limits.js";

function frameOf(message: unknown): string {
  return JSON.stringify(message);
}

describe("control plane to client messages", () => {
  const everyMessage: ControlPlaneToClientMessage[] = [
    { type: "replay_announcement", firstSequence: 5, lastSequence: 9 },
    {
      type: "thread_event",
      sequence: 5,
      recordedAt: "2026-11-24T09:00:00.000Z",
      event: { type: "user_message", messageId: "user-1", text: "Please say hello" },
    },
    {
      type: "thread_event",
      sequence: 6,
      recordedAt: "2026-11-24T09:00:01.000Z",
      event: { type: "agent_run_settled", wasInterrupted: false },
    },
    {
      type: "stream_fragment",
      fragment: {
        type: "assistant_text_fragment",
        messageId: "assistant-1",
        contentBlockIndex: 1,
        contentBlockType: "text",
        appendedText: " there.",
      },
    },
    { type: "supervisor_connection_status", isSupervisorConnected: false },
    { type: "client_message_rejected", reason: "The thread's supervisor is not connected." },
  ];

  it.each(everyMessage)("carry $type unchanged", (message) => {
    expect(parseControlPlaneToClientMessage(frameOf(message))).toEqual({
      ok: true,
      value: message,
    });
  });

  it("announce an empty replay when the client has missed nothing", () => {
    const message = { type: "replay_announcement", firstSequence: 1, lastSequence: 0 };

    expect(parseControlPlaneToClientMessage(frameOf(message)).ok).toBe(true);
  });

  it("reject a replay range that ends before it can begin", () => {
    const message = { type: "replay_announcement", firstSequence: 5, lastSequence: 3 };

    expect(parseControlPlaneToClientMessage(frameOf(message))).toEqual({
      ok: false,
      errorMessage: expect.stringContaining("lastSequence"),
    });
  });

  it("reject a replay range starting before the first sequence", () => {
    const message = { type: "replay_announcement", firstSequence: 0, lastSequence: 0 };

    expect(parseControlPlaneToClientMessage(frameOf(message)).ok).toBe(false);
  });

  it("reject a thread event without its sequence", () => {
    const message = {
      type: "thread_event",
      recordedAt: "2026-11-24T09:00:00.000Z",
      event: { type: "agent_run_started" },
    };

    expect(parseControlPlaneToClientMessage(frameOf(message))).toEqual({
      ok: false,
      errorMessage: expect.stringContaining("sequence"),
    });
  });

  it("reject a thread event with properties the protocol does not define", () => {
    const message = {
      type: "thread_event",
      sequence: 1,
      recordedAt: "2026-11-24T09:00:00.000Z",
      event: { type: "agent_run_started" },
      threadId: "thread-1",
    };

    expect(parseControlPlaneToClientMessage(frameOf(message))).toEqual({
      ok: false,
      errorMessage: expect.stringContaining('Unrecognized key: "threadId"'),
    });
  });

  it("reject a rejection reason longer than the limit", () => {
    const message = {
      type: "client_message_rejected",
      reason: "x".repeat(maximumErrorMessageLength + 1),
    };

    expect(parseControlPlaneToClientMessage(frameOf(message)).ok).toBe(false);
  });
});

describe("client to control plane messages", () => {
  const everyMessage: ClientToControlPlaneMessage[] = [
    { type: "authenticate", accessToken: "header.payload.signature" },
    { type: "send_user_message", text: "Please say hello" },
    { type: "interrupt_agent" },
  ];

  it.each(everyMessage)("carry $type unchanged", (message) => {
    expect(parseClientToControlPlaneMessage(frameOf(message))).toEqual({
      ok: true,
      value: message,
    });
  });

  it("reject a user message that tries to choose its own identifier", () => {
    const message = { type: "send_user_message", messageId: "user-1", text: "Hello" };

    expect(parseClientToControlPlaneMessage(frameOf(message))).toEqual({
      ok: false,
      errorMessage: expect.stringContaining('Unrecognized key: "messageId"'),
    });
  });

  it("reject an empty user message", () => {
    const message = { type: "send_user_message", text: "" };

    expect(parseClientToControlPlaneMessage(frameOf(message)).ok).toBe(false);
  });

  it("reject a user message longer than the limit", () => {
    const message = { type: "send_user_message", text: "x".repeat(maximumUserMessageLength + 1) };

    expect(parseClientToControlPlaneMessage(frameOf(message))).toEqual({
      ok: false,
      errorMessage: expect.stringContaining("text"),
    });
  });

  it("reject an unknown message type", () => {
    expect(parseClientToControlPlaneMessage(frameOf({ type: "delete_thread" })).ok).toBe(false);
  });

  it("reject authentication without a token, or with one longer than the limit", () => {
    const longToken = "x".repeat(maximumAccessTokenLength + 1);

    expect(parseClientToControlPlaneMessage(frameOf({ type: "authenticate" })).ok).toBe(false);
    expect(
      parseClientToControlPlaneMessage(frameOf({ type: "authenticate", accessToken: "" })).ok,
    ).toBe(false);
    expect(
      parseClientToControlPlaneMessage(frameOf({ type: "authenticate", accessToken: longToken }))
        .ok,
    ).toBe(false);
  });

  it("do not echo a refused token in the reason", () => {
    const message = { type: "authenticate", accessToken: "secret-token", extra: true };

    const parsed = parseClientToControlPlaneMessage(frameOf(message));

    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("secret-token");
  });
});

describe("the envelope a thread event is sent to clients in", () => {
  /** An assistant message whose supervisor frame is exactly as long as the protocol allows. */
  function largestAllowedAgentEvent(): AgentEvent {
    const event: AgentEvent = {
      type: "assistant_message",
      messageId: "message-1",
      content: [{ type: "text", text: "" }],
      endReason: "completed",
    };
    const emptyFrameLength = frameOf({ type: "agent_event", event }).length;
    const text = "x".repeat(maximumAgentEventFrameLength - emptyFrameLength);
    return { ...event, content: [{ type: "text", text }] };
  }

  it("fits in a frame around any agent event a supervisor may send, at the largest sequence", () => {
    const event = largestAllowedAgentEvent();
    const clientFrame = frameOf({
      type: "thread_event",
      sequence: Number.MAX_SAFE_INTEGER,
      recordedAt: new Date().toISOString(),
      event,
    });

    expect(frameOf({ type: "agent_event", event }).length).toBe(maximumAgentEventFrameLength);
    expect(measureLargestThreadEventFrame(event)).toBeLessThanOrEqual(maximumFrameLength);
    expect(clientFrame.length).toBeLessThanOrEqual(measureLargestThreadEventFrame(event));
    expect(parseControlPlaneToClientMessage(clientFrame).ok).toBe(true);
  });
});
