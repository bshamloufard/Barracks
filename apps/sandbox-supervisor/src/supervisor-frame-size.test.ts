import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { maximumFrameLength, parseSupervisorToControlPlaneMessage } from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { AgentHarness, AgentHarnessObserver } from "./agent-harness.js";
import { SameUserAgentLauncher } from "./agent-process/same-user-agent-launcher.js";
import { Supervisor } from "./supervisor.js";
import { createSilentLogger } from "./test-support/silent-logger.js";
import { startTestControlPlane, type TestControlPlane } from "./test-support/test-control-plane.js";
import { pause, waitUntil } from "./test-support/wait-until.js";

/**
 * No real harness can be made to produce a multi-megabyte event on demand,
 * so the harness is replaced by one that hands its observer to the test.
 */
const harnessObservers: AgentHarnessObserver[] = [];

vi.mock("./create-agent-harness.js", () => ({
  createAgentHarness: (_configuration: unknown, observer: AgentHarnessObserver): AgentHarness => {
    harnessObservers.push(observer);
    return {
      start: async () => {},
      deliverUserMessage: () => {},
      interrupt: async () => {},
      stop: async () => {},
    };
  },
}));

let controlPlane: TestControlPlane;
let supervisor: Supervisor;
let supervisorStateDirectory: string;

beforeEach(async () => {
  controlPlane = await startTestControlPlane();
  supervisorStateDirectory = await mkdtemp(path.join(tmpdir(), "barrack-supervisor-state-"));
  supervisor = new Supervisor({
    configuration: {
      controlPlaneUrl: controlPlane.url,
      threadId: "thread-1",
      supervisorToken: "token-1",
      supervisorStateDirectory,
      logLevel: "info",
      agentHarness: { kind: "fake" },
    },
    sourceEnvironment: {},
    agentProcessLauncher: new SameUserAgentLauncher(),
    logger: createSilentLogger(),
    onFatalError: (error) => {
      throw error;
    },
  });
  await supervisor.start();
  await waitUntil(() => controlPlane.connections.length === 1, "the supervisor connects");
});

afterEach(async () => {
  await supervisor.stop();
  await controlPlane.close();
  await rm(supervisorStateDirectory, { recursive: true, force: true });
});

function currentObserver(): AgentHarnessObserver {
  const observer = harnessObservers.at(-1);
  if (observer === undefined) {
    throw new Error("The supervisor did not create a harness.");
  }
  return observer;
}

describe("Supervisor with events too large for one frame", () => {
  it("sends a shrunk event the control plane accepts instead of a frame it would refuse", async () => {
    currentObserver().onAgentEvent({
      type: "assistant_message",
      messageId: "message-1",
      content: [{ type: "text", text: "x".repeat(maximumFrameLength) }],
      endReason: "completed",
    });

    await waitUntil(() => controlPlane.receivedFrames.length === 1, "the event arrives");

    const frame = controlPlane.receivedFrames[0] ?? "";
    const parsed = parseSupervisorToControlPlaneMessage(frame);
    expect(parsed.ok).toBe(true);
    expect(frame).toContain("characters omitted");
    expect(controlPlane.connections[0]?.readyState).toBe(WebSocket.OPEN);
  });

  it("drops a stream fragment too large for one frame and keeps the connection", async () => {
    currentObserver().onStreamFragment({
      type: "assistant_text_fragment",
      messageId: "message-1",
      contentBlockIndex: 0,
      contentBlockType: "text",
      appendedText: "x".repeat(maximumFrameLength),
    });
    currentObserver().onAgentEvent({ type: "agent_run_settled", wasInterrupted: false });

    await waitUntil(() => controlPlane.receivedFrames.length === 1, "the next event arrives");
    await pause(20);

    expect(controlPlane.receivedFrames.map((frame) => JSON.parse(frame))).toEqual([
      {
        type: "agent_event",
        eventNumber: 1,
        event: { type: "agent_run_settled", wasInterrupted: false },
      },
    ]);
  });
});
