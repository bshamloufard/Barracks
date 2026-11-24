import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ControlPlaneToSupervisorMessage, closeCodes } from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SameUserAgentLauncher } from "./agent-process/same-user-agent-launcher.js";
import { fakeAgentTriggers } from "./fake-agent/fake-agent-harness.js";
import { createLogger } from "./logger.js";
import { SecretRedactor } from "./secret-redactor.js";
import { Supervisor } from "./supervisor.js";
import { startTestControlPlane, type TestControlPlane } from "./test-support/test-control-plane.js";
import { pause, waitUntil } from "./test-support/wait-until.js";

let controlPlane: TestControlPlane;
let supervisorStateDirectory: string;
let supervisor: Supervisor;
let fatalErrors: Error[];
/** Everything every supervisor in the test logged, at every level. */
let logLines: string[];

function createSupervisor(): Supervisor {
  const secretRedactor = new SecretRedactor();
  const logger = createLogger("debug", "thread-1", secretRedactor, {
    write: (line: string) => logLines.push(line),
  });
  return new Supervisor({
    configuration: {
      controlPlaneUrl: controlPlane.url,
      threadId: "thread-1",
      supervisorToken: "token-1",
      supervisorStateDirectory,
      workspaceDirectory: undefined,
      gitCredentialSocketPath: path.join(supervisorStateDirectory, "git-credential.sock"),
      logLevel: "info",
      agentHarness: { kind: "fake" },
    },
    sourceEnvironment: {},
    agentProcessLauncher: new SameUserAgentLauncher(),
    logger,
    secretRedactor,
    onFatalError: (error) => fatalErrors.push(error),
    connectionTiming: { initialDelayInMilliseconds: 20, maximumDelayInMilliseconds: 40 },
  });
}

async function startSupervisor(): Promise<void> {
  supervisor = createSupervisor();
  await supervisor.start();
  const helloCount = controlPlane.hellos.length;
  await waitUntil(() => controlPlane.hellos.length > helloCount, "the supervisor says hello");
  // The welcome follows the hello; a message sent before it would race it.
  await pause(20);
  // As the real control plane does after every welcome, before any message.
  controlPlane.send({ type: "prepare_workspace", repository: null, agentHasWorkedBefore: false });
}

beforeEach(async () => {
  controlPlane = await startTestControlPlane();
  supervisorStateDirectory = await mkdtemp(path.join(tmpdir(), "barrack-supervisor-state-"));
  fatalErrors = [];
  logLines = [];
  await startSupervisor();
});

afterEach(async () => {
  await supervisor.stop();
  await controlPlane.close();
  await rm(supervisorStateDirectory, { recursive: true, force: true });
});

function sendFromControlPlane(message: ControlPlaneToSupervisorMessage): void {
  controlPlane.send(message);
}

function deliver(sequence: number, text: string): ControlPlaneToSupervisorMessage {
  return { type: "deliver_user_message", sequence, messageId: `user-${sequence}`, text };
}

/** What reached the control plane, with each agent event named by its type. */
function receivedTypes(): string[] {
  return controlPlane.receivedFrames.map((frame) => {
    const message = JSON.parse(frame);
    return message.type === "agent_event" ? message.event.type : message.type;
  });
}

function countReceived(type: string): number {
  return receivedTypes().filter((receivedType) => receivedType === type).length;
}

function lastAssistantText(): unknown {
  const assistantMessages = controlPlane.receivedFrames
    .map((frame) => JSON.parse(frame))
    .filter((message) => message.event?.type === "assistant_message");
  return assistantMessages.at(-1)?.event.content[0]?.text;
}

function lastReceivedEvent(): unknown {
  const agentEventFrames = controlPlane.receivedFrames
    .map((frame) => JSON.parse(frame))
    .filter((message) => message.type === "agent_event");
  return agentEventFrames.at(-1)?.event;
}

describe("Supervisor", () => {
  it("hands a delivered user message to the agent, acknowledges it, and relays the agent's run", async () => {
    sendFromControlPlane(deliver(1, "hi"));

    await waitUntil(() => receivedTypes().includes("agent_run_settled"), "the run settles");

    // The agent starts its run the moment it is handed the message, before
    // the acknowledgement goes out.
    expect(receivedTypes()).toEqual([
      "agent_run_started",
      "user_messages_delivered",
      "stream_fragment",
      "stream_fragment",
      "stream_fragment",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(JSON.parse(controlPlane.receivedFrames[1] ?? "null")).toEqual({
      type: "user_messages_delivered",
      throughSequence: 1,
    });
  });

  it("does not give the agent a user message delivered again, but acknowledges it again", async () => {
    sendFromControlPlane(deliver(1, "hi"));
    await waitUntil(() => countReceived("agent_run_settled") === 1, "the run settles");

    sendFromControlPlane(deliver(1, "hi"));
    await waitUntil(() => countReceived("user_messages_delivered") === 2, "it acknowledges again");
    await pause(200);

    expect(countReceived("agent_run_started")).toBe(1);
  });

  it("does not give the agent a user message it was handed before the supervisor restarted", async () => {
    sendFromControlPlane(deliver(3, "before the restart"));
    await waitUntil(() => countReceived("agent_run_settled") === 1, "the run settles");
    await supervisor.stop();

    await startSupervisor();
    sendFromControlPlane(deliver(3, "before the restart"));
    sendFromControlPlane(deliver(5, "after the restart"));
    await waitUntil(() => countReceived("agent_run_settled") === 2, "the second run settles");
    await pause(100);

    expect(controlPlane.hellos.at(-1)?.userMessagesDeliveredThroughSequence).toBe(3);
    const replies = controlPlane.receivedFrames
      .map((frame) => JSON.parse(frame))
      .filter((message) => message.type === "agent_event")
      .flatMap((message) =>
        message.event.type === "assistant_message" ? [message.event.content[0].text] : [],
      );
    expect(replies).toEqual(['You said: "before the restart"', 'You said: "after the restart"']);
  });

  it("numbers its events afresh, under a new identity, after it restarts", async () => {
    const firstInstanceId = controlPlane.hellos.at(-1)?.supervisorInstanceId;
    sendFromControlPlane(deliver(1, "hi"));
    await waitUntil(() => countReceived("agent_run_settled") === 1, "the run settles");
    await supervisor.stop();

    await startSupervisor();
    sendFromControlPlane(deliver(2, "again"));
    await waitUntil(() => countReceived("agent_run_settled") === 2, "the second run settles");

    const secondInstanceId = controlPlane.hellos.at(-1)?.supervisorInstanceId;
    const runStartNumbers = controlPlane.receivedFrames
      .map((frame) => JSON.parse(frame))
      .filter(
        (message) => message.type === "agent_event" && message.event.type === "agent_run_started",
      )
      .map((message) => message.eventNumber);
    expect(secondInstanceId).not.toBe(firstInstanceId);
    expect(runStartNumbers).toEqual([1, 1]);
  });

  it("interrupts the agent when the control plane asks", async () => {
    sendFromControlPlane(deliver(1, "a long message that takes a while to answer"));
    await waitUntil(() => receivedTypes().includes("stream_fragment"), "the reply starts");

    sendFromControlPlane({ type: "interrupt_agent" });
    await waitUntil(() => receivedTypes().includes("agent_run_settled"), "the run settles");

    expect(lastReceivedEvent()).toEqual({ type: "agent_run_settled", wasInterrupted: true });
  });

  it("hands the agent the thread's model and key, and keeps the key out of every event and log line, even when the agent repeats it", async () => {
    const secret = "sk-test-the-users-own-key-0123456789";
    sendFromControlPlane({
      type: "configure_model_access",
      model: "example/model-1",
      credential: { kind: "api_key", secret, settings: {} },
    });
    sendFromControlPlane(deliver(1, `${fakeAgentTriggers.model} and my key is ${secret}`));

    await waitUntil(() => receivedTypes().includes("agent_run_settled"), "the run settles");

    expect(lastAssistantText()).toBe("Running on example/model-1.");
    sendFromControlPlane(deliver(2, `please repeat ${secret}`));
    await waitUntil(() => countReceived("agent_run_settled") === 2, "the second run settles");
    expect(lastAssistantText()).toBe('You said: "please repeat [redacted model credential]"');
    expect(controlPlane.receivedFrames.join("\n")).not.toContain(secret);
    expect(logLines.join("\n")).toContain("Configuring the agent's model access");
    expect(logLines.join("\n")).not.toContain(secret);
    expect(Object.values(process.env)).not.toContain(secret);
  });

  it("answers, without running, a message for a model it has no key for, saying what to add", async () => {
    sendFromControlPlane({
      type: "configure_model_access",
      model: "example/model-1",
      credential: null,
    });
    sendFromControlPlane(deliver(1, "hello"));

    await waitUntil(() => receivedTypes().includes("agent_run_settled"), "the run settles");

    const erroredMessage = controlPlane.receivedFrames
      .map((frame) => JSON.parse(frame))
      .find((message) => message.event?.type === "assistant_message")?.event;
    expect(erroredMessage).toMatchObject({
      endReason: "errored",
      errorKind: "credential_missing",
      errorMessage: expect.stringContaining('no API key for the provider "example"'),
    });
  });

  it("reports a fatal error when a newer supervisor takes over the thread", async () => {
    controlPlane.connections[0]?.close(closeCodes.supersededByNewerSupervisor, "superseded");

    await waitUntil(() => fatalErrors.length === 1, "the supervisor gives up");
  });
});
