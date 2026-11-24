import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentProcessLauncher } from "../agent-process/agent-process-launcher.js";
import { SameUserAgentLauncher } from "../agent-process/same-user-agent-launcher.js";
import { isProcessRunning, unresponsivePiPath } from "../test-support/process-state.js";
import { RecordingObserver } from "../test-support/recording-observer.js";
import { createSilentLogger } from "../test-support/silent-logger.js";
import { waitUntil } from "../test-support/wait-until.js";
import { PiAgentHarness } from "./pi-agent-harness.js";

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "barrack-pi-stop-"));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

/** Launches the stand-in for a hung Pi wherever the harness asks for Pi. */
function launcherOfUnresponsivePi(): AgentProcessLauncher {
  const launcher = new SameUserAgentLauncher();
  return {
    description: "a stand-in for a hung Pi",
    launch: (request) => launcher.launch({ ...request, scriptPath: unresponsivePiPath }),
    launchCommand: (request) => launcher.launchCommand(request),
  };
}

describe("PiAgentHarness.stop", () => {
  it("finishes even when Pi never answers an interrupt, ending every process the agent started", async () => {
    const commandProcessIdFile = path.join(temporaryDirectory, "command-process-id");
    const observer = new RecordingObserver();
    const harness = new PiAgentHarness(observer, {
      threadId: "thread-1",
      workspaceDirectory: temporaryDirectory,
      stateDirectory: path.join(temporaryDirectory, "state"),
      sourceEnvironment: { PI_STUB_COMMAND_PROCESS_ID_FILE: commandProcessIdFile },
      agentProcessLauncher: launcherOfUnresponsivePi(),
      logger: createSilentLogger(),
      stopTiming: {
        commandInFlightTimeoutInMilliseconds: 200,
        gracefulExitTimeoutInMilliseconds: 200,
        terminatedExitTimeoutInMilliseconds: 200,
        killedExitTimeoutInMilliseconds: 2_000,
      },
    });
    await harness.start();
    harness.configureModelAccess({
      model: "mock/mock-1",
      credential: { kind: "api_key", secret: "key-for-mock", settings: {} },
    });
    await waitUntil(() => existsSync(commandProcessIdFile), "the stand-in for Pi has started");
    const commandProcessId = Number(await readFile(commandProcessIdFile, "utf8"));

    const interrupted = harness.interrupt();
    const stopStartedAt = Date.now();
    await harness.stop();
    const stopDurationInMilliseconds = Date.now() - stopStartedAt;
    await interrupted;

    expect(stopDurationInMilliseconds).toBeLessThan(3_000);
    expect(observer.processEndings).toEqual([
      { wasExpected: true, description: "Pi exited with signal SIGKILL." },
    ]);
    await waitUntil(() => !isProcessRunning(commandProcessId), "the agent's command has ended");
  });
});
