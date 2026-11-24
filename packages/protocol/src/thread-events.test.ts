import { describe, expect, expectTypeOf, it } from "vitest";
import { type AgentEvent, agentEventSchema } from "./agent-events.js";
import { maximumUserMessageLength } from "./limits.js";
import { recordedThreadEventSchema, type ThreadEvent, threadEventSchema } from "./thread-events.js";

const userMessage = { type: "user_message", messageId: "user-1", text: "Please say hello" };

describe("thread events", () => {
  it("include the user message alongside every agent event", () => {
    const agentEventTypes = agentEventSchema.options.map((option) => option.shape.type.value);
    const threadEventTypes = threadEventSchema.options.map((option) => option.shape.type.value);

    expect(threadEventTypes).toEqual(["user_message", ...agentEventTypes]);
  });

  it("exclude the user message from the events an agent may emit", () => {
    expect(agentEventSchema.safeParse(userMessage).success).toBe(false);
    expect(threadEventSchema.safeParse(userMessage).success).toBe(true);
    expectTypeOf<Extract<AgentEvent, { type: "user_message" }>>().toBeNever();
    expectTypeOf<Extract<ThreadEvent, { type: "user_message" }>>().not.toBeNever();
  });

  it("reject a user message longer than the limit", () => {
    const longMessage = { ...userMessage, text: "x".repeat(maximumUserMessageLength + 1) };

    expect(threadEventSchema.safeParse(longMessage).success).toBe(false);
  });
});

describe("recorded thread events", () => {
  const recordedAt = "2026-11-24T09:00:00.000Z";

  it("accept the first sequence of a thread", () => {
    const recorded = { sequence: 1, recordedAt, event: userMessage };

    expect(recordedThreadEventSchema.parse(recorded)).toEqual(recorded);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("reject the sequence %s", (sequence) => {
    const recorded = { sequence, recordedAt, event: userMessage };

    expect(recordedThreadEventSchema.safeParse(recorded).success).toBe(false);
  });

  it("reject a recording time that is not an ISO 8601 timestamp", () => {
    const recorded = { sequence: 1, recordedAt: "yesterday", event: userMessage };

    expect(recordedThreadEventSchema.safeParse(recorded).success).toBe(false);
  });
});
