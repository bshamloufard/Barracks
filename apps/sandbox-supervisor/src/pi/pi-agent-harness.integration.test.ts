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
import { waitUntil } from "../test-support/wait-until.js";
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
}

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

    expect(observer.eventTypes).toContain("agent_failed");
    expect(observer.processEndings[0]).toMatchObject({ wasExpected: false });
    expect(observer.eventTypes.slice(-3)).toEqual([
      "agent_run_started",
      "assistant_message",
      "agent_run_settled",
    ]);
    const lastConversation = JSON.stringify(modelServer.receivedConversations.at(-1));
    expect(lastConversation).toContain(mockModelTriggers.crash);
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
