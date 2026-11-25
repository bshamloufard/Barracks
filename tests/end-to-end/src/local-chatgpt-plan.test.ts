import { execFileSync } from "node:child_process";
import { FakeChatGptSignIn } from "@barrack/fake-chatgpt-sign-in";
import { type MockModelServer, startMockModelServer } from "@barrack/mock-model-server";
import {
  type AssistantMessageEvent,
  chatGptPlanApiPath,
  chatGptPlanDisconnectionSchema,
  chatGptPlanOpenAiAccessApiPath,
  chatGptPlanSignInApiPath,
  chatGptPlanSignInCompletionApiPath,
  chatGptPlanSignInStartSchema,
} from "@barrack/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type RunningControlPlane,
  startControlPlane,
  testClientOrigin,
} from "./support/local-system.js";
import { TestClient } from "./support/test-client.js";
import {
  createThread,
  deleteThread,
  saveModelCredential,
  waitUntilThreadIsGone,
} from "./support/threads-api.js";

/**
 * Milestone 4's second half, end to end: the user connects their ChatGPT
 * plan once, through the control plane's API as Settings uses it, and new
 * threads run the real Pi on it. Local-process sandboxes, whose Pi is
 * pointed at the control plane's model proxy; the proxy in front of the
 * mock model server, which answers plan requests as OpenAI's "Sign in with
 * ChatGPT" programme does; and the sign-in against a stand-in for OpenAI's.
 */

const planModel = "openai/gpt-6.1-sol";
const openAiKey = "fake-openai-key-of-the-owner-0009";

let signInServer: FakeChatGptSignIn;
let modelServer: MockModelServer;
let controlPlane: RunningControlPlane;
let pastedAddress: string;
const clients: TestClient[] = [];
const threadIds: string[] = [];

beforeAll(async () => {
  signInServer = await FakeChatGptSignIn.start();
  signInServer.addAccount({
    subject: "chatgpt-owner",
    email: "owner@chatgpt.example",
    isEligible: true,
  });
  modelServer = await startMockModelServer("127.0.0.1", {
    checkPlanToken: (token) => signInServer.checkAccessToken(token),
  });
  controlPlane = await startControlPlane({
    sandboxes: { kind: "local-process" },
    agent: { harness: "pi" },
    environment: {
      BARRACK_RUNNING_SANDBOXES_PER_USER: "20",
      BARRACK_MODEL_PROXY_UPSTREAM_ORIGIN: `development-only:${modelServer.origin}`,
      BARRACK_CHATGPT_PLAN_SIGN_IN: "on",
      BARRACK_CHATGPT_SIGN_IN_ISSUER: `development-only:${signInServer.issuer}`,
    },
  });
  pastedAddress = await connectPlan();
}, 60_000);

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
  await signInServer?.close();
});

function sendJson(method: "POST" | "PUT" | "DELETE", path: string, body: unknown) {
  return fetch(`${controlPlane.httpBaseUrl}${path}`, {
    method,
    headers: {
      origin: testClientOrigin,
      "content-type": "application/json",
      authorization: `Bearer ${controlPlane.accessToken}`,
    },
    body: JSON.stringify(body),
  });
}

/** Connects the plan as Settings does; the address the browser ended on, as pasted. */
async function connectPlan(): Promise<string> {
  const started = await sendJson("POST", chatGptPlanSignInApiPath, { allowsBackgroundUse: true });
  const { authorizationUrl } = chatGptPlanSignInStartSchema.parse(await started.json());
  const finalAddress = signInServer.approve(authorizationUrl, "chatgpt-owner");
  const finished = await sendJson("POST", chatGptPlanSignInCompletionApiPath, {
    finalAddress,
  });
  expect(finished.status).toBe(200);
  return finalAddress;
}

async function startThread(): Promise<TestClient> {
  const { threadId } = await createThread(controlPlane, planModel);
  threadIds.push(threadId);
  const client = await TestClient.connect(controlPlane, threadId, 0);
  clients.push(client);
  await client.waitUntilSupervisorIsConnected();
  return client;
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

describe("a ChatGPT plan with the real Pi", () => {
  it("is connected once, and two new threads then run on it", { timeout: 90_000 }, async () => {
    const requestsBefore = modelServer.receivedRequests.length;
    const [first, second] = [await startThread(), await startThread()];

    first.sendUserMessage("Say hello");
    second.sendUserMessage("Say hello too");
    await Promise.all([first.waitUntilRunsHaveSettled(1), second.waitUntilRunsHaveSettled(1)]);

    expect(assistantMessages(first).at(-1)).toMatchObject({ endReason: "completed" });
    expect(assistantMessages(second).at(-1)).toMatchObject({ endReason: "completed" });
    const received = modelServer.receivedRequests.slice(requestsBefore);
    expect(received).toHaveLength(2);
    for (const request of received) {
      expect(request.target).toBe("/v1/responses");
      expect(request.planAccount).toBe("chatgpt-owner");
      expect(request.memberNames).not.toContain("max_output_tokens");
    }
  });

  it("keeps every token, code and pasted address out of sandboxes, history and the log", {
    timeout: 90_000,
  }, async () => {
    const client = await startThread();
    client.sendUserMessage("Say hello");
    await client.waitUntilRunsHaveSettled(1);

    const secrets = [
      ...signInServer.issuedTokens,
      new URL(pastedAddress).searchParams.get("code") ?? "",
      new URL(pastedAddress).searchParams.get("state") ?? "",
      pastedAddress,
    ];
    const history = JSON.stringify(client.threadEvents());
    const log = controlPlane.process.describeOutput();
    expect(secrets.length).toBeGreaterThan(4);
    for (const secret of secrets) {
      expect(filesHolding(secret, controlPlane.sandboxesDirectory ?? "")).toEqual([]);
      expect(history).not.toContain(secret);
      expect(log).not.toContain(secret);
    }
  });

  it("stops a run cleanly when the plan's limit is reached, saying why, and resumes later", {
    timeout: 90_000,
  }, async () => {
    const client = await startThread();
    modelServer.setPlanSpent("chatgpt-owner", true);
    try {
      client.sendUserMessage("Say hello");
      await client.waitUntilRunsHaveSettled(1);

      expect(assistantMessages(client).at(-1)).toMatchObject({
        endReason: "errored",
        errorKind: "plan_limit_reached",
      });
    } finally {
      modelServer.setPlanSpent("chatgpt-owner", false);
    }

    client.sendUserMessage("Carry on");
    await client.waitUntilRunsHaveSettled(2);
    expect(assistantMessages(client).at(-1)).toMatchObject({ endReason: "completed" });
  });

  it("moves a thread from the plan to the user's API key and back, between runs", {
    timeout: 90_000,
  }, async () => {
    await saveModelCredential(controlPlane, "openai", openAiKey);
    const client = await startThread();
    const requestsBefore = modelServer.receivedRequests.length;

    expect(
      (await sendJson("PUT", chatGptPlanOpenAiAccessApiPath, { access: "api_key" })).status,
    ).toBe(200);
    client.sendUserMessage("Say hello on the key");
    await client.waitUntilRunsHaveSettled(1);
    expect(
      (await sendJson("PUT", chatGptPlanOpenAiAccessApiPath, { access: "chatgpt_plan" })).status,
    ).toBe(200);
    client.sendUserMessage("Say hello on the plan");
    await client.waitUntilRunsHaveSettled(2);

    const [onKey, onPlan] = modelServer.receivedRequests.slice(requestsBefore);
    expect(onKey?.credential).toBe(openAiKey);
    expect(onKey?.memberNames).toContain("max_output_tokens");
    expect(onPlan?.planAccount).toBe("chatgpt-owner");
    expect(onPlan?.memberNames).not.toContain("max_output_tokens");
  });

  it("is disconnected by revoking it at OpenAI, after which threads run on the key", {
    timeout: 90_000,
  }, async () => {
    const response = await sendJson("DELETE", chatGptPlanApiPath, {});

    expect(chatGptPlanDisconnectionSchema.parse(await response.json())).toMatchObject({
      status: { connection: null, openAiAccess: "api_key" },
      revocation: "revoked",
    });
    expect(signInServer.isSignInRevoked("chatgpt-owner")).toBe(true);
    const client = await startThread();
    client.sendUserMessage("Say hello");
    await client.waitUntilRunsHaveSettled(1);
    expect(modelServer.receivedRequests.at(-1)?.credential).toBe(openAiKey);
  });
});
