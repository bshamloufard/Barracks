import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type MockModelServer,
  mockModelTriggers,
  startMockModelServer,
} from "@barrack/mock-model-server";
import { agentEventSchema } from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelAccess } from "../agent-harness.js";
import { SameUserAgentLauncher } from "../agent-process/same-user-agent-launcher.js";
import { RecordingObserver } from "../test-support/recording-observer.js";
import { createSilentLogger } from "../test-support/silent-logger.js";
import { pause, waitUntil } from "../test-support/wait-until.js";
import { PiAgentHarness } from "./pi-agent-harness.js";
import { getPiDirectories } from "./pi-installation.js";

/**
 * Runs the real Pi, pinned in package.json, against a mock model on
 * 127.0.0.1. Pi is told to stay offline, and its models.json points two
 * providers, `mock` and `backup`, at the mock server, with no key of their
 * own: Pi gets the key the harness is handed, as a thread's owner's would
 * be, so the mock sees which key each request presented.
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

/** Two providers on the same mock, each with a model of its own, and no key in either. */
async function writeMockModelConfiguration(stateDirectory: string, baseUrl: string): Promise<void> {
  const { agentDirectory } = getPiDirectories(stateDirectory);
  await mkdir(agentDirectory, { recursive: true });
  const describeModel = (id: string) => ({
    id,
    name: id,
    contextWindow: 100_000,
    maxTokens: 4_096,
  });
  const modelsConfiguration = {
    providers: {
      mock: { baseUrl, api: "openai-completions", models: [describeModel("mock-1")] },
      backup: { baseUrl, api: "openai-completions", models: [describeModel("backup-1")] },
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

function accessTo(model: string, secret: string | undefined): ModelAccess {
  return {
    model,
    credential: secret === undefined ? null : { kind: "api_key", secret, settings: {} },
  };
}

const mockAccess = accessTo("mock/mock-1", "key-of-the-threads-owner");

function credentialFilePath(): string {
  const { agentDirectory } = getPiDirectories(path.join(temporaryDirectory, "state"));
  return path.join(agentDirectory, "auth.json");
}

async function startHarness(access: ModelAccess = mockAccess): Promise<PiAgentHarness> {
  let identifierCount = 0;
  const { PATH } = process.env;
  harness = new PiAgentHarness(observer, {
    threadId: "integration-thread",
    workspaceDirectory: path.join(temporaryDirectory, "workspace"),
    stateDirectory: path.join(temporaryDirectory, "state"),
    sourceEnvironment: { PATH, HOME: temporaryDirectory, PI_OFFLINE: "1" },
    agentProcessLauncher: new SameUserAgentLauncher(),
    logger: createSilentLogger(),
    mintIdentifier: () => `minted-${++identifierCount}`,
  });
  await harness.start();
  harness.configureModelAccess(access);
  return harness;
}

/** What the agent reports its last answer used: what the mock said, as Pi read it. */
function usageTheMockReported(model: string) {
  const reported = modelServer.receivedRequests.at(-1)?.usage;
  if (reported === undefined) {
    throw new Error("The mock's last answer reported no usage.");
  }
  return { model, ...reported };
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
        usage: usageTheMockReported("mock/mock-1"),
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
        usage: usageTheMockReported("mock/mock-1"),
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

  it("reports a key the provider rejects as credential_rejected, without retrying", {
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
        errorKind: "credential_rejected",
      }),
      { type: "agent_run_settled", wasInterrupted: false },
    ]);
  });

  it("reports an exhausted quota as quota_exhausted, without retrying, though it comes as a 429", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({
      messageId: "user-1",
      text: `Please ${mockModelTriggers.exhaustedQuota}`,
    });
    await waitUntil(hasEnded(1), "the run settles", piTimeoutInMilliseconds);

    expect(modelServer.receivedConversations).toHaveLength(1);
    expect(observer.events).toEqual([
      { type: "agent_run_started" },
      expect.objectContaining({
        endReason: "errored",
        errorMessage: expect.stringContaining("insufficient_quota"),
        errorKind: "quota_exhausted",
      }),
      { type: "agent_run_settled", wasInterrupted: false },
    ]);
  });

  it("reports a rate limit as rate_limited once Pi's retries have run out", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({
      messageId: "user-1",
      text: `Please ${mockModelTriggers.rateLimit}`,
    });
    await waitUntil(hasEnded(1), "the run settles", piTimeoutInMilliseconds);

    expect(modelServer.receivedConversations).toHaveLength(4);
    expect(observer.events).toEqual([
      { type: "agent_run_started" },
      expect.objectContaining({
        endReason: "errored",
        errorMessage: expect.stringContaining("Rate limit reached"),
        errorKind: "rate_limited",
      }),
      { type: "agent_run_settled", wasInterrupted: false },
    ]);
  });

  it("hands Pi the owner's key in a file only its user can read, and erases it when stopped", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({ messageId: "user-1", text: "Say hello" });
    await waitUntil(hasEnded(1), "the run settles", piTimeoutInMilliseconds);

    expect(modelServer.receivedCredentials).toEqual(["key-of-the-threads-owner"]);
    expect((await stat(credentialFilePath())).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credentialFilePath(), "utf8"))).toEqual({
      mock: { type: "api_key", key: "key-of-the-threads-owner" },
    });
    await harness.stop();
    expect(existsSync(credentialFilePath())).toBe(false);
  });

  it("uses a replaced key from the next request, without starting Pi again", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness(accessTo("mock/mock-1", "first-key-0001"));
    harness.deliverUserMessage({ messageId: "user-1", text: "Say hello" });
    await waitUntil(hasEnded(1), "the first run settles", piTimeoutInMilliseconds);

    harness.configureModelAccess(accessTo("mock/mock-1", "second-key-0002"));
    harness.deliverUserMessage({ messageId: "user-2", text: "Say hello again" });
    await waitUntil(hasEnded(2), "the second run settles", piTimeoutInMilliseconds);

    expect(modelServer.receivedCredentials).toEqual(["first-key-0001", "second-key-0002"]);
    expect(observer.processEndings).toEqual([]);
  });

  it("moves to another provider's model for the next run, which is sent the conversation so far", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({ messageId: "user-1", text: "Remember the word heliotrope" });
    await waitUntil(hasEnded(1), "the first run settles", piTimeoutInMilliseconds);

    harness.configureModelAccess(accessTo("backup/backup-1", "key-for-the-backup"));
    harness.deliverUserMessage({ messageId: "user-2", text: "Which word?" });
    await waitUntil(hasEnded(2), "the second run settles", piTimeoutInMilliseconds);

    expect(modelServer.receivedModels).toEqual(["mock-1", "backup-1"]);
    expect(modelServer.receivedCredentials).toEqual([
      "key-of-the-threads-owner",
      "key-for-the-backup",
    ]);
    expect(JSON.stringify(modelServer.receivedConversations.at(-1))).toContain("heliotrope");
    expect(observer.countEvents("agent_failed")).toBe(0);
  });

  it("lets the run in progress finish on its own model when the thread switches provider mid-run, and switches for the next", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({
      messageId: "user-1",
      text: `${mockModelTriggers.command}sleep 2 && echo slept`,
    });
    await waitUntil(
      () => observer.countEvents("tool_execution_started") === 1,
      "the run's tool starts",
      piTimeoutInMilliseconds,
    );

    harness.configureModelAccess(accessTo("backup/backup-1", "key-for-the-backup"));
    await waitUntil(hasEnded(1), "the first run settles", piTimeoutInMilliseconds);
    harness.deliverUserMessage({ messageId: "user-2", text: "Carry on" });
    await waitUntil(hasEnded(2), "the second run settles", piTimeoutInMilliseconds);

    expect(observer.countEvents("agent_failed")).toBe(0);
    const assistantMessages = observer.events.filter((event) => event.type === "assistant_message");
    expect(assistantMessages.map((message) => message.endReason)).toEqual([
      "tool_use_requested",
      "completed",
      "completed",
    ]);
    expect(modelServer.receivedModels).toEqual(["mock-1", "mock-1", "backup-1"]);
    expect(modelServer.receivedCredentials).toEqual([
      "key-of-the-threads-owner",
      "key-of-the-threads-owner",
      "key-for-the-backup",
    ]);
    expect(JSON.parse(await readFile(credentialFilePath(), "utf8"))).toEqual({
      backup: { type: "api_key", key: "key-for-the-backup" },
    });
  });

  it("sends a relayed provider's requests, with the proxy token, where the control plane says, and nothing of a key", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    // The mock stands in for the control plane's model proxy here: the
    // agent's own Anthropic client sends to the base URL it was given.
    const proxyBaseUrl = `${modelServer.origin}/threads/integration-thread/model-proxy/anthropic`;
    const harness = await startHarness({
      model: "anthropic/claude-haiku-4-5",
      credential: {
        kind: "proxy_token",
        secret: "proxy-token-for-the-thread",
        baseUrl: proxyBaseUrl,
      },
    });
    harness.deliverUserMessage({ messageId: "user-1", text: "Say hello" });
    await waitUntil(hasEnded(1), "the run settles", piTimeoutInMilliseconds);

    expect(modelServer.receivedRequests.map((request) => request.target)).toEqual([
      "/threads/integration-thread/model-proxy/anthropic/v1/messages?beta=true",
    ]);
    expect(modelServer.receivedRequests[0]?.credential).toBe("proxy-token-for-the-thread");
    expect(observer.events.at(-2)).toMatchObject({
      endReason: "completed",
      usage: usageTheMockReported("anthropic/claude-haiku-4-5"),
    });
    const { agentDirectory } = getPiDirectories(path.join(temporaryDirectory, "state"));
    const models = JSON.parse(await readFile(path.join(agentDirectory, "models.json"), "utf8"));
    expect(models.providers.anthropic).toEqual({ baseUrl: proxyBaseUrl });
    expect(models.providers.mock).toMatchObject({ api: "openai-completions" });

    harness.configureModelAccess(mockAccess);
    harness.deliverUserMessage({ messageId: "user-2", text: "Say hello again" });
    await waitUntil(hasEnded(2), "the second run settles", piTimeoutInMilliseconds);
    const modelsAfter = JSON.parse(
      await readFile(path.join(agentDirectory, "models.json"), "utf8"),
    );
    expect(modelsAfter.providers.anthropic).toBeUndefined();
    expect(modelsAfter.providers.mock).toMatchObject({ api: "openai-completions" });
  });

  it("erases a withdrawn key at once, answers without the model until another comes, then carries on", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness();
    harness.deliverUserMessage({ messageId: "user-1", text: "Say hello" });
    await waitUntil(hasEnded(1), "the first run settles", piTimeoutInMilliseconds);

    harness.configureModelAccess(accessTo("mock/mock-1", undefined));
    harness.deliverUserMessage({ messageId: "user-2", text: "Are you there?" });
    await waitUntil(hasEnded(2), "the refusal is reported", piTimeoutInMilliseconds);

    expect(existsSync(credentialFilePath())).toBe(false);
    expect(observer.events.at(-2)).toMatchObject({
      endReason: "errored",
      errorKind: "credential_missing",
    });
    expect(modelServer.receivedConversations).toHaveLength(1);

    harness.configureModelAccess(accessTo("mock/mock-1", "a-new-key-0003"));
    harness.deliverUserMessage({ messageId: "user-3", text: "And now?" });
    await waitUntil(hasEnded(3), "the third run settles", piTimeoutInMilliseconds);

    expect(modelServer.receivedCredentials).toEqual(["key-of-the-threads-owner", "a-new-key-0003"]);
    expect(JSON.stringify(modelServer.receivedConversations.at(-1))).toContain("Say hello");
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

  it("answers a message for a model it has no key for in an errored message of its own, without starting Pi", {
    timeout: piTimeoutInMilliseconds,
  }, async () => {
    const harness = await startHarness(accessTo("mock/mock-1", undefined));
    harness.deliverUserMessage({ messageId: "user-1", text: "Say hello" });
    await waitUntil(hasEnded(1), "the run settles", piTimeoutInMilliseconds);

    expect(observer.events).toEqual([
      { type: "agent_run_started" },
      {
        type: "assistant_message",
        messageId: "minted-1",
        content: [],
        endReason: "errored",
        errorMessage: expect.stringContaining('no API key for the provider "mock"'),
        errorKind: "credential_missing",
      },
      { type: "agent_run_settled", wasInterrupted: false },
    ]);
    expect(modelServer.receivedConversations).toEqual([]);
    expect(observer.processEndings).toEqual([]);
  });
});
