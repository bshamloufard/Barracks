import { describe, expect, it } from "vitest";
import { buildThreadApiPath, threadResponseSchema } from "./threads-api.js";

describe("the threads API", () => {
  it("addresses one thread under the threads path", () => {
    expect(buildThreadApiPath("thread-1")).toBe("/api/threads/thread-1");
  });

  it("accepts a failed thread only with a reason", () => {
    const failedThread = {
      threadId: "thread-1",
      createdAt: "2026-11-24T09:00:00.000Z",
      sandbox: { state: "failed" },
    };

    expect(threadResponseSchema.safeParse({ thread: failedThread }).success).toBe(false);
    expect(
      threadResponseSchema.safeParse({
        thread: { ...failedThread, sandbox: { state: "failed", reason: "No quota left" } },
      }).success,
    ).toBe(true);
  });

  it("refuses a thread carrying fields it does not define, such as a token", () => {
    const thread = {
      threadId: "thread-1",
      createdAt: "2026-11-24T09:00:00.000Z",
      sandbox: { state: "ready" },
      supervisorToken: "never sent",
    };

    expect(threadResponseSchema.safeParse({ thread }).success).toBe(false);
  });
});
