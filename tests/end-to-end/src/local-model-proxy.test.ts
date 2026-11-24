import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type MockModelServer,
  mockModelTriggers,
  startMockModelServer,
} from "@barrack/mock-model-server";
import {
  type AssistantMessageEvent,
  buildThreadModelUsageApiPath,
  modelUsageApiPath,
  ownUsageCapApiPath,
  threadModelUsageResponseSchema,
  userModelUsageResponseSchema,
} from "@barrack/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type RunningControlPlane, startControlPlane } from "./support/local-system.js";
import { TestClient } from "./support/test-client.js";
import {
  createThread,
  deleteThread,
  saveModelCredential,
  waitUntilThreadIsGone,
} from "./support/threads-api.js";

/**
 * The model proxy with the real Pi: local-process sandboxes, whose Pi is
 * pointed at the control plane's proxy by the supervisor, and the proxy
 * pointed at the mock model, which speaks each relayed provider's own
 * format. This is where the agent's failure classification is shown to
 * survive the proxy, and the usage cap to end a run.
 */

const keys = {
  anthropic: "sk-ant-real-owner-key-0000000001",
  openai: "sk-real-owner-openai-key-000002",
};

let modelServer: MockModelServer;
let controlPlane: RunningControlPlane;
const clients: TestClient[] = [];
const threadIds: string[] = [];

beforeAll(async () => {
  modelServer = await startMockModelServer();
  controlPlane = await startControlPlane({
    sandboxes: { kind: "local-process" },
    agent: { harness: "pi" },
    environment: {
      BARRACK_RUNNING_SANDBOXES_PER_USER: "20",
      BARRACK_MODEL_PROXY_UPSTREAM_ORIGIN: `development-only:${modelServer.origin}`,
    },
  });
  await saveModelCredential(controlPlane, "anthropic", keys.anthropic);
  await saveModelCredential(controlPlane, "openai", keys.openai);
}, 60_000);

/** Each test's threads go when it ends, so only one test's Pi runs at a time. */
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const threadId of threadIds.splice(0)) {
    await deleteThread(controlPlane, threadId);
    await waitUntilThreadIsGone(controlPlane, threadId);
  }
}, 60_000);

afterAll(async () => {
  await controlPlane?.stop();
  await modelServer?.close();
});

/**
 * Pi retries a rate-limited request after 2 s, doubling; a test need not
 * wait that long, so every sandbox's Pi is told to wait 10 ms instead.
 */
async function hurryPiRetries(): Promise<void> {
  const sandboxesDirectory = controlPlane.sandboxesDirectory ?? "";
  for (const sandbox of await readdir(sandboxesDirectory)) {
    const agentDirectory = path.join(sandboxesDirectory, sandbox, "state", "pi", "agent");
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      path.join(agentDirectory, "settings.json"),
      JSON.stringify({ retry: { baseDelayMs: 10, provider: { maxRetries: 0 } } }),
    );
  }
}

async function startThread(model: string): Promise<{ threadId: string; client: TestClient }> {
  const { threadId } = await createThread(controlPlane, model);
  threadIds.push(threadId);
  const client = await TestClient.connect(controlPlane, threadId, 0);
  clients.push(client);
  await client.waitUntilSupervisorIsConnected();
  await hurryPiRetries();
  return { threadId, client };
}

function assistantMessages(client: TestClient): AssistantMessageEvent[] {
  return client
    .threadEvents()
    .flatMap((message) => (message.event.type === "assistant_message" ? [message.event] : []));
}

/** Every file under `directory` that holds `text`, as grep finds them. */
function filesHolding(text: string, directory: string): string[] {
  try {
    return execFileSync("grep", ["-rlF", text, directory], { encoding: "utf8" }).trim().split("\n");
  } catch (error) {
    // grep exits 1 when it finds nothing.
    if (typeof error === "object" && error !== null && "status" in error && error.status === 1) {
      return [];
    }
    throw error;
  }
}

async function getJson(apiPath: string): Promise<unknown> {
  const response = await fetch(`${controlPlane.httpBaseUrl}${apiPath}`, {
    headers: { authorization: `Bearer ${controlPlane.accessToken}` },
  });
  return response.json();
}

async function setOwnCap(tokens: number | null): Promise<void> {
  const response = await fetch(`${controlPlane.httpBaseUrl}${ownUsageCapApiPath}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${controlPlane.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ tokens }),
  });
  expect(response.status).toBe(200);
}

/** Every sandbox's Pi `models.json`, as text, joined. */
async function readEveryAgentsModelsFile(): Promise<string> {
  const sandboxesDirectory = controlPlane.sandboxesDirectory ?? "";
  const modelsFiles = (await readdir(sandboxesDirectory))
    .map((sandbox) => path.join(sandboxesDirectory, sandbox, "state", "pi", "agent", "models.json"))
    .filter((modelsFile) => existsSync(modelsFile));
  const contents = await Promise.all(modelsFiles.map((modelsFile) => readFile(modelsFile, "utf8")));
  return contents.join("\n");
}

describe("the model proxy with the real Pi", () => {
  it.each([
    ["anthropic", "anthropic/claude-haiku-4-5", "anthropic_messages"],
    ["openai", "openai/gpt-4", "openai_responses"],
  ] as const)(
    "relays %s's requests with the owner's key, which the sandbox never holds, and measures them",
    { timeout: 60_000 },
    async (providerId, model, format) => {
      const requestsBefore = modelServer.receivedRequests.length;
      const { threadId, client } = await startThread(model);

      client.sendUserMessage("Say hello");
      await client.waitUntilRunsHaveSettled(1);

      expect(assistantMessages(client).at(-1)).toMatchObject({ endReason: "completed" });
      const [request] = modelServer.receivedRequests.slice(requestsBefore);
      expect(request?.format).toBe(format);
      // The provider's own path: the proxy's, with its thread and provider, stays behind.
      expect(request?.target).toBe(
        format === "anthropic_messages" ? "/v1/messages?beta=true" : "/v1/responses",
      );
      expect(request?.credential).toBe(keys[providerId]);
      expect(filesHolding(keys[providerId], controlPlane.sandboxesDirectory ?? "")).toEqual([]);
      const usage = threadModelUsageResponseSchema.parse(
        await getJson(buildThreadModelUsageApiPath(threadId)),
      );
      expect(usage.byModel).toEqual([
        expect.objectContaining({
          providerId,
          source: "measured",
          inputTokens: request?.usage?.inputTokens,
          outputTokens: request?.usage?.outputTokens,
          answerCount: 1,
        }),
      ]);
    },
  );

  it.each([
    ["anthropic/claude-haiku-4-5", mockModelTriggers.invalidKey, "credential_rejected"],
    ["anthropic/claude-haiku-4-5", mockModelTriggers.exhaustedQuota, "quota_exhausted"],
    ["anthropic/claude-haiku-4-5", mockModelTriggers.rateLimit, "rate_limited"],
    ["openai/gpt-4", mockModelTriggers.invalidKey, "credential_rejected"],
    ["openai/gpt-4", mockModelTriggers.exhaustedQuota, "quota_exhausted"],
    ["openai/gpt-4", mockModelTriggers.rateLimit, "rate_limited"],
  ])(
    "on %s, still classifies %s as %s through the proxy",
    { timeout: 60_000 },
    async (model, trigger, errorKind) => {
      const { client } = await startThread(model);

      client.sendUserMessage(`Please ${trigger}`);
      await client.waitUntilRunsHaveSettled(1);

      expect(assistantMessages(client).at(-1)).toMatchObject({ endReason: "errored", errorKind });
    },
  );

  it("ends a run cleanly once the owner's cap is reached, and refuses further messages", {
    timeout: 60_000,
  }, async () => {
    const before = userModelUsageResponseSchema.parse(await getJson(modelUsageApiPath));
    await setOwnCap(before.cap.countedTokensInWindow + 1);
    const { client } = await startThread("anthropic/claude-haiku-4-5");
    const requestsBefore = modelServer.receivedRequests.length;
    try {
      client.sendUserMessage(`Please ${mockModelTriggers.toolExecution}`);
      await client.waitUntilRunsHaveSettled(1);

      expect(assistantMessages(client).map((message) => message.endReason)).toEqual([
        "tool_use_requested",
        "errored",
      ]);
      expect(assistantMessages(client).at(-1)).toMatchObject({ errorKind: "usage_cap_reached" });
      expect(modelServer.receivedRequests.length - requestsBefore).toBe(1);
      client.sendUserMessage("Carry on");
      await client.waitUntil("the message is refused", (messages) =>
        messages.some(
          (message) =>
            message.type === "client_message_rejected" &&
            message.reason.includes("model usage cap"),
        ),
      );
    } finally {
      await setOwnCap(null);
    }
  });

  it("points the agent's Pi at the proxy, with a token in place of the key", {
    timeout: 60_000,
  }, async () => {
    const { threadId } = await startThread("anthropic/claude-haiku-4-5");
    const proxyBaseUrl = `${controlPlane.httpBaseUrl}/threads/${threadId}/model-proxy/anthropic`;

    await expect.poll(readEveryAgentsModelsFile).toContain(proxyBaseUrl);
    expect(filesHolding(keys.anthropic, controlPlane.sandboxesDirectory ?? "")).toEqual([]);
  });
});
