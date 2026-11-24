import { describe, expect, it } from "vitest";
import { parsePiRecord, parsePiState } from "./pi-records.js";

describe("parsePiRecord", () => {
  it("reads a response with its identifier and outcome", () => {
    const parsed = parsePiRecord(
      '{"id":"barrack-1","type":"response","command":"prompt","success":false,"error":"busy"}',
    );

    expect(parsed).toEqual({
      ok: true,
      value: {
        kind: "response",
        response: {
          id: "barrack-1",
          type: "response",
          command: "prompt",
          success: false,
          error: "busy",
        },
      },
    });
  });

  it("accepts known events that carry fields it does not use", () => {
    const parsed = parsePiRecord(
      '{"type":"agent_settled","aborted":false,"addedInAFutureVersion":1}',
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: { kind: "event", event: { type: "agent_settled" } },
    });
  });

  it("reports record types it does not know as unrecognized instead of failing", () => {
    const parsed = parsePiRecord('{"type":"queue_update","steering":[],"followUp":[]}');

    expect(parsed).toEqual({ ok: true, value: { kind: "unrecognized", type: "queue_update" } });
  });

  it("rejects a known event whose fields have the wrong shape", () => {
    const parsed = parsePiRecord('{"type":"agent_settled","aborted":"no"}');

    expect(parsed.ok).toBe(false);
  });

  it("marks assistant content blocks of unknown types so they can be skipped", () => {
    const parsed = parsePiRecord(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "hologram", frames: 3 },
            { type: "text", text: "hi" },
          ],
          stopReason: "stop",
        },
      }),
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        event: {
          message: { content: [{ unrecognized: "hologram" }, { type: "text", text: "hi" }] },
        },
      },
    });
  });

  it("rejects an assistant message whose tool call is malformed rather than passing it as unrecognized", () => {
    const parsed = parsePiRecord(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1" }],
          stopReason: "toolUse",
        },
      }),
    );

    expect(parsed.ok).toBe(false);
  });

  it("marks messages from other roles so they can be skipped", () => {
    const parsed = parsePiRecord(
      '{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: { event: { message: { otherRole: "user" } } },
    });
  });

  it("rejects a line that is not JSON", () => {
    expect(parsePiRecord("Warning: something").ok).toBe(false);
  });

  it("rejects a record without a type", () => {
    expect(parsePiRecord('{"id":"x"}').ok).toBe(false);
  });
});

describe("parsePiState", () => {
  it("reads the session file from Pi's state", () => {
    const parsed = parsePiState({ sessionFile: "/state/session.jsonl", isStreaming: false });

    expect(parsed).toMatchObject({ ok: true, value: { sessionFile: "/state/session.jsonl" } });
  });
});
