import { randomBytes } from "node:crypto";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { InMemoryThreadStore } from "./in-memory-thread-store.js";
import {
  failInterruptedSandboxCreations,
  interruptedCreationReason,
} from "./interrupted-sandbox-creations.js";

describe("failing interrupted sandbox creations at startup", () => {
  it("marks a thread left creating its sandbox as failed, saying the control plane restarted", async () => {
    const threadStore = new InMemoryThreadStore();
    await threadStore.create({
      threadId: "thread-a",
      sandboxProvider: "docker",
      supervisorTokenDigest: randomBytes(32),
    });

    await failInterruptedSandboxCreations(threadStore, pino({ level: "silent" }));

    expect((await threadStore.find("thread-a"))?.sandbox).toEqual({
      state: "failed",
      reason: interruptedCreationReason,
    });
    expect(interruptedCreationReason).toContain(
      "restarted while this thread's sandbox was being created",
    );
  });
});
