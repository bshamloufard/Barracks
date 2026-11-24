import { type ControlPlaneToSupervisorMessage, closeCodes } from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SameUserAgentLauncher } from "./agent-process/same-user-agent-launcher.js";
import { Supervisor } from "./supervisor.js";
import { createSilentLogger } from "./test-support/silent-logger.js";
import { startTestControlPlane, type TestControlPlane } from "./test-support/test-control-plane.js";
import { waitUntil } from "./test-support/wait-until.js";

let controlPlane: TestControlPlane;
let supervisor: Supervisor;
let fatalErrors: Error[];

beforeEach(async () => {
  controlPlane = await startTestControlPlane();
  fatalErrors = [];
  supervisor = new Supervisor({
    configuration: {
      controlPlaneUrl: controlPlane.url,
      threadId: "thread-1",
      supervisorToken: "token-1",
      logLevel: "info",
      agentHarness: { kind: "fake" },
    },
    sourceEnvironment: {},
    agentProcessLauncher: new SameUserAgentLauncher(),
    logger: createSilentLogger(),
    onFatalError: (error) => fatalErrors.push(error),
  });
  await supervisor.start();
  await waitUntil(() => controlPlane.connections.length === 1, "the supervisor connects");
});

afterEach(async () => {
  await supervisor.stop();
  await controlPlane.close();
});

function sendFromControlPlane(message: ControlPlaneToSupervisorMessage): void {
  controlPlane.connections[0]?.send(JSON.stringify(message));
}

/** What reached the control plane, with each agent event named by its type. */
function receivedTypes(): string[] {
  return controlPlane.receivedFrames.map((frame) => {
    const message = JSON.parse(frame);
    return message.type === "agent_event" ? message.event.type : message.type;
  });
}

function lastReceivedEvent(): unknown {
  return JSON.parse(controlPlane.receivedFrames.at(-1) ?? "null")?.event;
}

describe("Supervisor", () => {
  it("relays the agent's run for a delivered user message to the control plane", async () => {
    sendFromControlPlane({ type: "deliver_user_message", messageId: "user-1", text: "hi" });

    await waitUntil(() => receivedTypes().includes("agent_run_settled"), "the run settles");

    expect(receivedTypes()).toEqual([
      "agent_run_started",
      "stream_fragment",
      "stream_fragment",
      "stream_fragment",
      "assistant_message",
      "agent_run_settled",
    ]);
  });

  it("interrupts the agent when the control plane asks", async () => {
    sendFromControlPlane({
      type: "deliver_user_message",
      messageId: "user-1",
      text: "a long message that takes a while to answer",
    });
    await waitUntil(() => receivedTypes().includes("stream_fragment"), "the reply starts");

    sendFromControlPlane({ type: "interrupt_agent" });
    await waitUntil(() => receivedTypes().includes("agent_run_settled"), "the run settles");

    expect(lastReceivedEvent()).toEqual({ type: "agent_run_settled", wasInterrupted: true });
  });

  it("reports a fatal error when a newer supervisor takes over the thread", async () => {
    controlPlane.connections[0]?.close(closeCodes.supersededByNewerSupervisor, "superseded");

    await waitUntil(() => fatalErrors.length === 1, "the supervisor gives up");
  });
});
