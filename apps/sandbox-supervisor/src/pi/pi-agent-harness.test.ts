import { describe, expect, it } from "vitest";
import { SameUserAgentLauncher } from "../agent-process/same-user-agent-launcher.js";
import { RecordingObserver } from "../test-support/recording-observer.js";
import { createSilentLogger } from "../test-support/silent-logger.js";
import { waitUntil } from "../test-support/wait-until.js";
import { PiAgentHarness } from "./pi-agent-harness.js";

const modelAccess = {
  model: "mock/mock-1",
  credential: { kind: "api_key", secret: "key-for-mock", settings: {} },
} as const;

describe("PiAgentHarness", () => {
  it("reports agent_failed, rather than throwing, when its agent directory cannot be made", async () => {
    const observer = new RecordingObserver();
    const harness = new PiAgentHarness(observer, {
      threadId: "thread-1",
      workspaceDirectory: "/",
      // A directory cannot be created inside a character device.
      stateDirectory: "/dev/null/state",
      sourceEnvironment: {},
      agentProcessLauncher: new SameUserAgentLauncher(),
      logger: createSilentLogger(),
    });

    await harness.start();
    harness.configureModelAccess(modelAccess);
    await waitUntil(() => observer.events.length > 0, "the failure is reported");

    expect(observer.events).toEqual([
      {
        type: "agent_failed",
        errorMessage: expect.stringContaining("The agent's key could not be handed to it"),
      },
    ]);
  });
});
