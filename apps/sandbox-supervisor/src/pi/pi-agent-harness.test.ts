import { describe, expect, it } from "vitest";
import { RecordingObserver } from "../test-support/recording-observer.js";
import { createSilentLogger } from "../test-support/silent-logger.js";
import { PiAgentHarness } from "./pi-agent-harness.js";

describe("PiAgentHarness", () => {
  it("reports agent_failed, rather than throwing, when Pi cannot be started", async () => {
    const observer = new RecordingObserver();
    const harness = new PiAgentHarness(observer, {
      threadId: "thread-1",
      model: "mock/mock-1",
      workspaceDirectory: "/",
      // A directory cannot be created inside a character device.
      stateDirectory: "/dev/null/state",
      sourceEnvironment: {},
      logger: createSilentLogger(),
    });

    await harness.start();

    expect(observer.events).toEqual([
      { type: "agent_failed", errorMessage: expect.stringContaining("Pi could not be started") },
    ]);
  });
});
