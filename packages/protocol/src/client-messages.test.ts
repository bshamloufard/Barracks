import { describe, expect, it } from "vitest";
import {
  type ClientToControlPlaneMessage,
  type ControlPlaneToClientMessage,
  parseClientToControlPlaneMessage,
  parseControlPlaneToClientMessage,
} from "./client-messages.js";
import { maximumErrorMessageLength, maximumUserMessageLength } from "./limits.js";

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
});
