import { describe, expect, it } from "vitest";
import {
  buildResumeThreadApiPath,
  buildStopThreadApiPath,
  buildThreadApiPath,
  threadResponseSchema,
} from "./threads-api.js";

const runningThread = {
  threadId: "thread-1",
  createdAt: "2026-11-24T09:00:00.000Z",
  lastActiveAt: "2026-11-24T09:05:00.000Z",
  title: "Fix the build",
  isAgentWorking: false,
  sandbox: { state: "running" },
  repository: null,
  model: "anthropic/example-model",
};

describe("the threads API", () => {
  it("addresses one thread, and stopping and resuming it, under the threads path", () => {
    expect(buildThreadApiPath("thread-1")).toBe("/api/threads/thread-1");
    expect(buildStopThreadApiPath("thread-1")).toBe("/api/threads/thread-1/stop");
    expect(buildResumeThreadApiPath("thread-1")).toBe("/api/threads/thread-1/resume");
  });

  it("accepts a failed thread only with a reason and whether it can be resumed", () => {
    const parse = (sandbox: object) =>
      threadResponseSchema.safeParse({ thread: { ...runningThread, sandbox } }).success;

    expect(parse({ state: "failed" })).toBe(false);
    expect(parse({ state: "failed", reason: "No quota left" })).toBe(false);
    expect(parse({ state: "failed", reason: "No quota left", canResume: true })).toBe(true);
  });

  it("accepts a thread with no title yet as null", () => {
    const parsed = threadResponseSchema.safeParse({ thread: { ...runningThread, title: null } });

    expect(parsed.success).toBe(true);
  });

  it("refuses a thread carrying fields it does not define, such as a token", () => {
    const thread = { ...runningThread, supervisorToken: "never sent" };

    expect(threadResponseSchema.safeParse({ thread }).success).toBe(false);
  });
});
