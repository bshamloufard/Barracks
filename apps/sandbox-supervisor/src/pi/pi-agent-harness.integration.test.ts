import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentEventSchema } from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type MockModelServer,
  mockModelTriggers,
  startMockModelServer,
} from "../test-support/mock-model-server.js";
import { RecordingObserver } from "../test-support/recording-observer.js";
import { createSilentLogger } from "../test-support/silent-logger.js";
import { pause, waitUntil } from "../test-support/wait-until.js";
import { getPiDirectories, PiAgentHarness } from "./pi-agent-harness.js";

/**
 * Runs the real Pi, pinned in package.json, against a mock model on
 * 127.0.0.1. Pi is told to stay offline, and its models.json points the
 * `mock` provider at the mock server, so the test needs no network and no
 * API key.
 */

const piTimeoutInMilliseconds = 30_000;

let modelServer: MockModelServer;
let temporaryDirectory: string;
let harness: PiAgentHarness | undefined;
let observer: RecordingObserver;

beforeEach(async () => {
  modelServer = await startMockModelServer();
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "barrack-pi-harness-"));
  await mkdir(path.join(temporaryDirectory, "workspace"));
  await writeMockModelConfiguration(path.join(temporaryDirectory, "state"), modelServer.baseUrl);
  observer = new RecordingObserver();
});

afterEach(async () => {
  await harness?.stop();
  await modelServer.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

/** Two providers on the same mock: `mock` has a key, `keyless` reads one from a variable that is never set. */
async function writeMockModelConfiguration(stateDirectory: string, baseUrl: string): Promise<void> {
  const { agentDirectory } = getPiDirectories(stateDirectory);
  await mkdir(agentDirectory, { recursive: true });
  const model = { id: "mock-1", name: "Mock 1", contextWindow: 100_000, maxTokens: 4_096 };
  const modelsConfiguration = {
    providers: {
      mock: { baseUrl, api: "openai-completions", apiKey: "not-a-real-key", models: [model] },
      keyless: { baseUrl, api: "openai-completions", apiKey: "$UNSET_MOCK_KEY", models: [model] },
    },
  };
  await writeFile(path.join(agentDirectory, "models.json"), JSON.stringify(modelsConfiguration));
  await writeRetrySettings(stateDirectory, quickRetryDelayInMilliseconds);
}

/**
 * Pi retries a failed model request after `baseDelayMs`, doubling each time
 * (2 s by default); the model client's own retries are turned off so that
 * every failure reaches Pi's retry logic, which is what the tests are about.
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md
 */
async function writeRetrySettings(stateDirectory: string, baseDelayInMilliseconds: number) {
  const { agentDirectory } = getPiDirectories(stateDirectory);
  const settings = { retry: { baseDelayMs: baseDelayInMilliseconds, provider: { maxRetries: 0 } } };
  await writeFile(path.join(agentDirectory, "settings.json"), JSON.stringify(settings));
}

const quickRetryDelayInMilliseconds = 10;

async function startHarness(model = "mock/mock-1"): Promise<PiAgentHarness> {
  let identifierCount = 0;
  const { PATH } = process.env;
  harness = new PiAgentHarness(observer, {
    threadId: "integration-thread",
    model,
    workspaceDirectory: path.join(temporaryDirectory, "workspace"),
    stateDirectory: path.join(temporaryDirectory, "state"),
    sourceEnvironment: { PATH, HOME: temporaryDirectory, PI_OFFLINE: "1" },
    logger: createSilentLogger(),
    mintIdentifier: () => `minted-${++identifierCount}`,
  });
  await harness.start();
  return harness;
}

function hasEnded(runCount: number): () => boolean {
  return () =>
    observer.countEvents("agent_run_settled") + observer.countEvents("agent_failed") >= runCount;
}

describe("PiAgentHarness with the real Pi", () => {
  it("answers a user message with run started, fragments, the completed message and run settled", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({ messageId: "user-1", text: "Say hello" });
    await waitUntil(hasEnded(1), "the run settles", piTimeoutInMilliseconds);

    expect(observer.outputTypes).toEqual([
      "agent_run_started",
      "fragment",
      "fragment",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(observer.events).toEqual([
      { type: "agent_run_started" },
      {
        type: "assistant_message",
        messageId: "minted-1",
        content: [{ type: "text", text: "Hello there." }],
        endReason: "completed",
      },
      { type: "agent_run_settled", wasInterrupted: false },
    ]);
  });

  it("runs a tool for real in the workspace and reports its output", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({
      messageId: "user-1",
      text: `Please ${mockModelTriggers.toolExecution}`,
    });
    await waitUntil(hasEnded(1), "the run settles", piTimeoutInMilliseconds);

    expect(observer.eventTypes).toEqual([
      "agent_run_started",
      "assistant_message",
      "tool_execution_started",
      "tool_execution_finished",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(observer.events[3]).toMatchObject({
      toolName: "bash",
      isError: false,
      output: { text: "hi\n", isTruncated: false },
    });
    for (const event of observer.events) {
      expect(agentEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("reports a crash as agent_failed and resumes the same conversation on the next message", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({ messageId: "user-1", text: `Please ${mockModelTriggers.crash}` });
    await waitUntil(hasEnded(1), "Pi crashes", piTimeoutInMilliseconds);
    harness.deliverUserMessage({ messageId: "user-2", text: "Are you back?" });
    await waitUntil(hasEnded(2), "the next run settles", piTimeoutInMilliseconds);

    // The crash ends the first run with agent_failed alone, and the second
    // run is a new one.
    expect(observer.eventTypes).toEqual([
      "agent_run_started",
      "assistant_message",
      "tool_execution_started",
      "agent_failed",
      "agent_run_started",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(observer.processEndings[0]).toMatchObject({ wasExpected: false });
    const lastConversation = JSON.stringify(modelServer.receivedConversations.at(-1));
    expect(lastConversation).toContain(mockModelTriggers.crash);
  });

  it("settles the run as interrupted when stopped in the middle of it", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({
      messageId: "user-1",
      text: `Please ${mockModelTriggers.slowReply}`,
    });
    await waitUntil(
      () => observer.outputTypes.includes("fragment"),
      "the reply starts",
      piTimeoutInMilliseconds,
    );

    await harness.stop();

    expect(observer.eventTypes[0]).toBe("agent_run_started");
    expect(observer.events.at(-1)).toEqual({ type: "agent_run_settled", wasInterrupted: true });
    expect(observer.countEvents("agent_run_settled")).toBe(1);
    expect(observer.countEvents("agent_failed")).toBe(0);
    expect(observer.processEndings).toEqual([
      { wasExpected: true, description: expect.any(String) },
    ]);
  });

  it("answers a message sent right after an interrupt in a new run, once the interrupted one settles", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({
      messageId: "user-1",
      text: `Please ${mockModelTriggers.slowReply}`,
    });
    await waitUntil(
      () => observer.outputTypes.includes("fragment"),
      "the reply starts",
      piTimeoutInMilliseconds,
    );

    const interrupted = harness.interrupt();
    harness.deliverUserMessage({ messageId: "user-2", text: "Say hello" });
    await interrupted;
    await waitUntil(hasEnded(2), "the second run settles", piTimeoutInMilliseconds);

    expect(observer.eventTypes).toEqual([
      "agent_run_started",
      "assistant_message",
      "agent_run_settled",
      "agent_run_started",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(observer.events[1]).toMatchObject({ endReason: "interrupted" });
    expect(observer.events[2]).toEqual({ type: "agent_run_settled", wasInterrupted: true });
    expect(observer.events[4]).toMatchObject({
      endReason: "completed",
      content: [{ type: "text", text: "Hello there." }],
    });
  });

  it("drops messages still waiting to reach Pi when interrupted", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({
      messageId: "user-1",
      text: `Please ${mockModelTriggers.slowReply}`,
    });
    await waitUntil(
      () => observer.outputTypes.includes("fragment"),
      "the reply starts",
      piTimeoutInMilliseconds,
    );

    harness.deliverUserMessage({ messageId: "user-2", text: "Say hello" });
    await harness.interrupt();
    await pause(300);

    expect(observer.eventTypes).toEqual([
      "agent_run_started",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(modelServer.receivedConversations).toHaveLength(1);
  });

  it("records no error when a failed model request succeeds on Pi's retry", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({
      messageId: "user-1",
      text: `Please ${mockModelTriggers.transientFailure}`,
    });
    await waitUntil(hasEnded(1), "the run settles", piTimeoutInMilliseconds);

    expect(modelServer.receivedConversations).toHaveLength(2);
    expect(observer.events).toEqual([
      { type: "agent_run_started" },
      {
        type: "assistant_message",
        messageId: "minted-2",
        content: [{ type: "text", text: "Hello there." }],
        endReason: "completed",
      },
      { type: "agent_run_settled", wasInterrupted: false },
    ]);
  });

  it("records one error, the last, when every retry of a failed model request fails", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({
      messageId: "user-1",
      text: `Please ${mockModelTriggers.persistentFailure}`,
    });
    await waitUntil(hasEnded(1), "the run settles", piTimeoutInMilliseconds);

    expect(modelServer.receivedConversations).toHaveLength(4);
    expect(observer.events).toEqual([
      { type: "agent_run_started" },
      {
        type: "assistant_message",
        messageId: "minted-4",
        content: [],
        endReason: "errored",
        errorMessage: expect.stringContaining("The model is overloaded."),
      },
      { type: "agent_run_settled", wasInterrupted: false },
    ]);
  });

  it("records a model provider error that Pi does not retry", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({
      messageId: "user-1",
      text: `Please ${mockModelTriggers.invalidKey}`,
    });
    await waitUntil(hasEnded(1), "the run settles", piTimeoutInMilliseconds);

    expect(modelServer.receivedConversations).toHaveLength(1);
    expect(observer.events).toEqual([
      { type: "agent_run_started" },
      expect.objectContaining({
        endReason: "errored",
        errorMessage: expect.stringContaining("Incorrect API key provided"),
      }),
      { type: "agent_run_settled", wasInterrupted: false },
    ]);
  });

  it("records the error, and settles as interrupted, when interrupted while Pi waits to retry", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    await writeRetrySettings(path.join(temporaryDirectory, "state"), 20_000);
    const harness = await startHarness();
    harness.deliverUserMessage({
      messageId: "user-1",
      text: `Please ${mockModelTriggers.persistentFailure}`,
    });
    await waitUntil(
      () => modelServer.receivedConversations.length === 1,
      "the first request fails",
      piTimeoutInMilliseconds,
    );
    // Gives Pi time to read the failure and start waiting to retry.
    await pause(500);
    await harness.interrupt();

    expect(modelServer.receivedConversations).toHaveLength(1);
    expect(observer.events).toEqual([
      { type: "agent_run_started" },
      expect.objectContaining({ endReason: "errored" }),
      { type: "agent_run_settled", wasInterrupted: true },
    ]);
  });

  it("shows a message Pi refuses as an errored assistant message in a run of its own", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness("keyless/mock-1");
    harness.deliverUserMessage({ messageId: "user-1", text: "Say hello" });
    await waitUntil(hasEnded(1), "the run settles", piTimeoutInMilliseconds);

    expect(observer.events).toEqual([
      { type: "agent_run_started" },
      {
        type: "assistant_message",
        messageId: "minted-1",
        content: [],
        endReason: "errored",
        errorMessage: expect.stringContaining("Pi did not accept the message"),
      },
      { type: "agent_run_settled", wasInterrupted: false },
    ]);
    expect(modelServer.receivedConversations).toEqual([]);
  });
});
