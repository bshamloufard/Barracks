import {
  type MockModelServer,
  mockModelTriggers,
  startMockModelServer,
} from "@barrack/mock-model-server";
import { findCatalogueProvider, findModelLimits } from "@barrack/model-catalogue";
import {
  type AgentEvent,
  buildResumeThreadApiPath,
  buildStopThreadApiPath,
  buildThreadModelApiPath,
  ownUsageCapApiPath,
} from "@barrack/protocol";
import { FakeSandboxProvider } from "@barrack/sandbox-providers";
import { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialKeyring } from "../model-access/credential-keyring.js";
import { InMemoryModelCredentialStore } from "../model-access/in-memory-model-credential-store.js";
import { InMemoryModelUsageStore } from "../model-usage/in-memory-model-usage-store.js";
import { ControllableClock } from "../test-support/controllable-clock.js";
import { ControllableThreadEventLog, Gate } from "../test-support/controllable-thread-event-log.js";
import {
  callModelProxy,
  type ProxyAccess,
  relayedFormatExamples,
  waitForProxyAccess,
} from "../test-support/model-proxy-peers.js";
import {
  TestControlPlane,
  type TestControlPlaneOptions,
  type TestThread,
} from "../test-support/test-control-plane.js";
import type { FakeSupervisor } from "../test-support/test-peers.js";
import { InMemoryThreadStore } from "../threads/in-memory-thread-store.js";
import { InMemoryModelProxyTokenStore } from "./in-memory-model-proxy-token-store.js";
import { previousModelAllowedForInMilliseconds } from "./model-switch-allowances.js";

/**
 * The model proxy through the real control plane, in front of the mock
 * model server speaking each relayed provider's own format: a sandbox's
 * agent presents its thread's proxy token, and the provider sees its
 * owner's key and nothing of the sandbox's. Two users sign in with tokens
 * from a test identity issuer.
 */

const ada = { userId: "11111111-1111-4111-8111-111111111111", email: "ada@example.com" };
const grace = { userId: "22222222-2222-4222-8222-222222222222", email: "grace@example.com" };

const keys = {
  adasAnthropic: "fake-anthropic-key-of-ada-0001",
  adasOpenAi: "fake-openai-key-of-ada-0002",
  adasGroq: "fake-groq-key-of-ada-0003",
  gracesAnthropic: "fake-anthropic-key-of-grace-0004",
  adasReplacement: "fake-anthropic-key-of-ada-replaced-0005",
  adasOpenRouter: "fake-openrouter-key-of-ada-0006",
};

let modelServer: MockModelServer;
let issuer: TestIdentityIssuer;
let controlPlane: TestControlPlane;
let adaToken: string;
let graceToken: string;

beforeEach(async () => {
  modelServer = await startMockModelServer();
  issuer = await TestIdentityIssuer.start();
  adaToken = await issuer.mintAccessToken(ada);
  graceToken = await issuer.mintAccessToken(grace);
});

afterEach(async () => {
  await controlPlane?.close();
  await issuer.close();
  await modelServer.close();
});

async function start(options: Omit<TestControlPlaneOptions, "authentication"> = {}) {
  controlPlane = await TestControlPlane.start({
    authentication: { kind: "test-issuer", issuer },
    modelProxyUpstreamOrigin: modelServer.origin,
    ...options,
  });
}

/** A thread of the user's on `model`, with its supervisor attached and its proxy token in hand. */
async function startThread(
  userToken: string,
  model: string,
): Promise<{ thread: TestThread; supervisor: FakeSupervisor; access: ProxyAccess }> {
  const thread = await controlPlane.createThread(userToken, model);
  const supervisor = await controlPlane.connectSupervisor(thread);
  const providerId = model.split("/")[0] ?? "";
  return { thread, supervisor, access: await waitForProxyAccess(supervisor, providerId) };
}

/** The thread's owner switches its model, as Settings would. */
async function switchModel(threadId: string, model: string): Promise<void> {
  const response = await controlPlane.sendJson(
    "PUT",
    buildThreadModelApiPath(threadId),
    { model },
    adaToken,
  );
  expect(response.status).toBe(200);
}

/** Sends a supervisor's agent events one at a time, each recorded before the next. */
function runEventsOf(supervisor: FakeSupervisor) {
  let eventNumber = 0;
  return {
    async send(event: AgentEvent): Promise<void> {
      eventNumber += 1;
      supervisor.sendAgentEventNumbered(eventNumber, event);
      await supervisor.waitUntilRecorded(eventNumber);
    },
  };
}

/** Everything the agent was sent, as bytes, to search for keys in. */
async function readWholeAnswer(response: Response): Promise<string> {
  return Buffer.from(await response.arrayBuffer()).toString("latin1");
}

function everyKey(): string[] {
  return Object.values(keys);
}

/** A token store that counts its lookups, and how many run at once, and can hold the next. */
class CountingTokenStore extends InMemoryModelProxyTokenStore {
  lookups = 0;
  peakLookupsAtOnce = 0;
  #lookupsAtOnce = 0;
  #gate: Gate | undefined;

  holdLookups(): Gate {
    this.#gate = new Gate();
    return this.#gate;
  }

  reset(): void {
    this.lookups = 0;
    this.peakLookupsAtOnce = 0;
  }

  override async listDigests(threadId: string, providerId: string): Promise<Buffer[]> {
    this.lookups += 1;
    this.#lookupsAtOnce += 1;
    this.peakLookupsAtOnce = Math.max(this.peakLookupsAtOnce, this.#lookupsAtOnce);
    try {
      await this.#gate?.pass();
      return await super.listDigests(threadId, providerId);
    } finally {
      this.#lookupsAtOnce -= 1;
    }
  }
}

describe("the model proxy", () => {
  it.each(Object.values(relayedFormatExamples))(
    "relays $providerId's API with the owner's key, streams the answer back, and measures its usage",
    async (example) => {
      await start();
      const ownersKey = {
        anthropic: keys.adasAnthropic,
        openai: keys.adasOpenAi,
        groq: keys.adasGroq,
      }[example.providerId];
      await controlPlane.saveModelCredential(example.providerId, ownersKey, adaToken);
      await controlPlane.saveModelCredential("anthropic", keys.gracesAnthropic, graceToken);
      const { thread, access } = await startThread(adaToken, `${example.providerId}/a-model`);

      const response = await callModelProxy(controlPlane, access, example, "Say hello");
      const answer = await readWholeAnswer(response);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(answer).toContain("Hello");
      const [received] = modelServer.receivedRequests;
      expect(received?.credential).toBe(ownersKey);
      expect(JSON.stringify(received?.headers)).not.toContain(access.token);
      for (const key of everyKey()) {
        expect(answer).not.toContain(key);
        expect(JSON.stringify([...response.headers])).not.toContain(key);
      }
      await expect
        .poll(() => controlPlane.modelUsage.listForThread(ada.userId, thread.threadId))
        .toEqual([
          {
            providerId: example.providerId,
            modelId: example.body("").model,
            source: "measured",
            ...received?.usage,
            answerCount: 1,
          },
        ]);
    },
  );

  it("accepts at a second control plane, during a redeploy's overlap, a token the first minted", async () => {
    const shared = {
      threadStore: new InMemoryThreadStore(),
      modelCredentialStore: new InMemoryModelCredentialStore(
        new CredentialKeyring(Buffer.alloc(32, 7)),
      ),
      modelProxyTokenStore: new InMemoryModelProxyTokenStore(),
      modelUsageStore: new InMemoryModelUsageStore(),
      threadEventLog: new ControllableThreadEventLog(),
      sandboxProvider: new FakeSandboxProvider(),
    };
    await start(shared);
    const minting = controlPlane;
    const other = await TestControlPlane.start({
      authentication: { kind: "test-issuer", issuer },
      modelProxyUpstreamOrigin: modelServer.origin,
      ...shared,
    });
    try {
      await minting.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
      const { thread, access } = await startThread(adaToken, "anthropic/a-model");

      const response = await callModelProxy(
        other,
        access,
        relayedFormatExamples.anthropic,
        "Say hello",
      );
      await readWholeAnswer(response);

      expect(response.status).toBe(200);
      expect(modelServer.receivedCredentials).toEqual([keys.adasAnthropic]);
      await expect
        .poll(() => minting.modelUsage.listForThread(ada.userId, thread.threadId))
        .toEqual([expect.objectContaining({ source: "measured", answerCount: 1 })]);
    } finally {
      await other.close();
    }
  });

  it("ends a request in flight here soon after the other control plane stops its thread", async () => {
    const shared = {
      threadStore: new InMemoryThreadStore(),
      modelCredentialStore: new InMemoryModelCredentialStore(
        new CredentialKeyring(Buffer.alloc(32, 7)),
      ),
      modelProxyTokenStore: new InMemoryModelProxyTokenStore(),
      threadEventLog: new ControllableThreadEventLog(),
      sandboxProvider: new FakeSandboxProvider(),
    };
    await start(shared);
    const stopping = controlPlane;
    const relaying = await TestControlPlane.start({
      authentication: { kind: "test-issuer", issuer },
      modelProxyUpstreamOrigin: modelServer.origin,
      modelProxyLimits: { reauthorizationIntervalInMilliseconds: 200 },
      ...shared,
    });
    try {
      await stopping.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
      const { thread, access } = await startThread(adaToken, "anthropic/a-model");
      const inFlight = await callModelProxy(
        relaying,
        access,
        relayedFormatExamples.anthropic,
        `Please ${mockModelTriggers.slowReply}`,
      );
      expect(inFlight.status).toBe(200);

      await stopping.sendApi("POST", buildStopThreadApiPath(thread.threadId), adaToken);
      const startedWaiting = Date.now();
      await expect(inFlight.text()).rejects.toThrow();

      expect(Date.now() - startedWaiting).toBeLessThan(2_000);
      await expect.poll(() => modelServer.receivedRequests[0]?.wasAbandoned).toBe(true);
    } finally {
      await relaying.close();
    }
  });

  it("ends a request in flight soon after its owner's key is removed", async () => {
    await start({ modelProxyLimits: { reauthorizationIntervalInMilliseconds: 200 } });
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { access } = await startThread(adaToken, "anthropic/a-model");
    const inFlight = await callModelProxy(
      controlPlane,
      access,
      relayedFormatExamples.anthropic,
      `Please ${mockModelTriggers.slowReply}`,
    );
    expect(inFlight.status).toBe(200);

    await controlPlane.sendJson("DELETE", "/api/model-credentials/anthropic", {}, adaToken);

    await expect(inFlight.text()).rejects.toThrow();
    await expect.poll(() => modelServer.receivedRequests[0]?.wasAbandoned).toBe(true);
  });

  it("rebuilds the request's headers, keeping only what the provider needs", async () => {
    await start();
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { access } = await startThread(adaToken, "anthropic/a-model");

    const response = await callModelProxy(
      controlPlane,
      access,
      relayedFormatExamples.anthropic,
      "Say hello",
      {
        headers: {
          authorization: `Bearer ${access.token}`,
          cookie: "session=stolen",
          "x-forwarded-for": "10.0.0.1",
          "openai-organization": "org-elsewhere",
          "x-stainless-os": "Linux",
          "anthropic-beta": "interleaved-thinking-2025-05-14",
        },
      },
    );
    await readWholeAnswer(response);

    const headers = modelServer.receivedRequests[0]?.headers ?? {};
    expect(headers["x-api-key"]).toBe(keys.adasAnthropic);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
    expect(headers["accept-encoding"]).toBe("identity");
    for (const dropped of [
      "authorization",
      "cookie",
      "x-forwarded-for",
      "openai-organization",
      "x-stainless-os",
    ]) {
      expect(headers[dropped]).toBeUndefined();
    }
  });

  it.each([
    ["GET", "/v1/messages", 405],
    ["POST", "/v1/models", 404],
    ["POST", "/v1/messages?beta=true&other=1", 404],
    ["POST", "/v1/messages/../complete", 404],
    ["POST", "/v1/%6Dessages", 404],
    ["POST", "/v1//messages", 404],
  ])(
    "refuses %s %s, which it does not relay, before reading any credential",
    async (method, apiPath, status) => {
      await start();
      await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
      const { access } = await startThread(adaToken, "anthropic/a-model");

      const response = await fetch(`${controlPlane.httpBaseUrl}${access.basePath}${apiPath}`, {
        method,
        headers: { "x-api-key": access.token },
        ...(method === "GET" ? {} : { body: "{}" }),
      });

      expect(response.status).toBe(status);
      expect(modelServer.receivedRequests).toEqual([]);
    },
  );

  it("refuses a provider whose key is placed in the sandbox", async () => {
    await start();
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { thread, access } = await startThread(adaToken, "anthropic/a-model");

    const response = await fetch(
      `${controlPlane.httpBaseUrl}/threads/${thread.threadId}/model-proxy/mistral/v1/chat/completions`,
      { method: "POST", headers: { authorization: `Bearer ${access.token}` }, body: "{}" },
    );

    expect(response.status).toBe(404);
  });

  it("never lets one thread's token spend another user's key, or reach another provider", async () => {
    await start();
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    await controlPlane.saveModelCredential("openai", keys.adasOpenAi, adaToken);
    await controlPlane.saveModelCredential("anthropic", keys.gracesAnthropic, graceToken);
    const adas = await startThread(adaToken, "anthropic/a-model");
    const graces = await startThread(graceToken, "anthropic/a-model");
    const anthropic = relayedFormatExamples.anthropic;

    const onGracesThread = await callModelProxy(
      controlPlane,
      { ...adas.access, basePath: graces.access.basePath },
      anthropic,
      "Spend Grace's key",
    );
    const onAnotherProvider = await callModelProxy(
      controlPlane,
      { ...adas.access, basePath: adas.access.basePath.replace("/anthropic", "/openai") },
      relayedFormatExamples.openai,
      "Spend Ada's OpenAI key",
    );
    const withoutToken = await callModelProxy(
      controlPlane,
      { ...adas.access, token: "" },
      anthropic,
      "Spend anything",
    );
    const withGuessedToken = await callModelProxy(
      controlPlane,
      { ...adas.access, token: "a-guessed-token-0000000000000" },
      anthropic,
      "Spend anything",
    );

    for (const refused of [onGracesThread, onAnotherProvider, withoutToken, withGuessedToken]) {
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { type: "permission_error" } });
    }
    expect(modelServer.receivedRequests).toEqual([]);
  });

  it("stops accepting a thread's token as soon as its sandbox stops, and ends its requests in flight", async () => {
    await start();
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { thread, access } = await startThread(adaToken, "anthropic/a-model");
    const inFlight = await callModelProxy(
      controlPlane,
      access,
      relayedFormatExamples.anthropic,
      `Please ${mockModelTriggers.slowReply}`,
    );
    expect(inFlight.status).toBe(200);

    await controlPlane.sendApi("POST", buildStopThreadApiPath(thread.threadId), adaToken);
    await expect(inFlight.text()).rejects.toThrow();
    await controlPlane.whenOperationsSettle();
    const afterStop = await callModelProxy(
      controlPlane,
      access,
      relayedFormatExamples.anthropic,
      "Say hello",
    );

    expect(afterStop.status).toBe(403);
    await expect.poll(() => modelServer.receivedRequests[0]?.wasAbandoned).toBe(true);
    expect(modelServer.receivedRequests).toHaveLength(1);
  });

  it("gives a resumed sandbox's supervisor a new token, and never accepts the old one again", async () => {
    await start();
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { thread, supervisor, access } = await startThread(adaToken, "anthropic/a-model");
    await controlPlane.sendApi("POST", buildStopThreadApiPath(thread.threadId), adaToken);
    await controlPlane.whenOperationsSettle();
    await supervisor.close();

    await controlPlane.sendApi("POST", buildResumeThreadApiPath(thread.threadId), adaToken);
    await controlPlane.whenOperationsSettle();
    const resumed = await controlPlane.connectSupervisor(thread);
    const newAccess = await waitForProxyAccess(resumed, "anthropic");
    const withNew = await callModelProxy(
      controlPlane,
      newAccess,
      relayedFormatExamples.anthropic,
      "Hi",
    );
    const withOld = await callModelProxy(
      controlPlane,
      access,
      relayedFormatExamples.anthropic,
      "Hi",
    );

    expect(newAccess.token).not.toBe(access.token);
    expect(withNew.status).toBe(200);
    expect(withOld.status).toBe(403);
    await withNew.body?.cancel();
  });

  it("lets a run finish on the provider the thread switched from, and refuses that provider once the run is over", async () => {
    await start();
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    await controlPlane.saveModelCredential("openai", keys.adasOpenAi, adaToken);
    const { thread, supervisor, access } = await startThread(adaToken, "anthropic/a-model");
    const anthropic = relayedFormatExamples.anthropic;
    supervisor.sendAgentEvent({ type: "agent_run_started" });
    await supervisor.waitUntilRecorded(1);

    const switched = await controlPlane.sendJson(
      "PUT",
      buildThreadModelApiPath(thread.threadId),
      { model: "openai/a-model" },
      adaToken,
    );
    await waitForProxyAccess(supervisor, "openai");
    const duringTheRun = await callModelProxy(controlPlane, access, anthropic, "Carry on");
    await readWholeAnswer(duringTheRun);
    supervisor.sendAgentEvent({ type: "agent_run_settled", wasInterrupted: false });
    await supervisor.waitUntilRecorded(2);
    const afterTheRun = await callModelProxy(controlPlane, access, anthropic, "One more");

    expect(switched.status).toBe(200);
    expect(duringTheRun.status).toBe(200);
    expect(afterTheRun.status).toBe(403);
    expect(modelServer.receivedCredentials).toEqual([keys.adasAnthropic]);
  });

  it("uses a replaced key from the next request, and refuses once it is removed, saying so", async () => {
    await start();
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { access } = await startThread(adaToken, "anthropic/a-model");
    const anthropic = relayedFormatExamples.anthropic;

    await readWholeAnswer(await callModelProxy(controlPlane, access, anthropic, "First"));
    await controlPlane.saveModelCredential("anthropic", keys.adasReplacement, adaToken);
    await readWholeAnswer(await callModelProxy(controlPlane, access, anthropic, "Second"));
    await controlPlane.sendJson("DELETE", "/api/model-credentials/anthropic", {}, adaToken);
    const afterRemoval = await callModelProxy(controlPlane, access, anthropic, "Third");

    expect(modelServer.receivedCredentials).toEqual([keys.adasAnthropic, keys.adasReplacement]);
    expect(afterRemoval.status).toBe(403);
    expect(await afterRemoval.json()).toMatchObject({
      error: { message: expect.stringContaining("No API key found") },
    });
  });

  it("refuses once the owner's usage cap is reached, in words the agent's harness recognises", async () => {
    await start({ modelUsageCap: { installationCapTokens: 1_000_000 } });
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { thread, access } = await startThread(adaToken, "anthropic/a-model");
    const lowerCap = await controlPlane.sendJson(
      "PUT",
      ownUsageCapApiPath,
      { tokens: 1 },
      adaToken,
    );
    const aboveInstallation = await controlPlane.sendJson(
      "PUT",
      ownUsageCapApiPath,
      { tokens: 2_000_000 },
      adaToken,
    );

    const first = await callModelProxy(controlPlane, access, relayedFormatExamples.anthropic, "Hi");
    await readWholeAnswer(first);
    await expect
      .poll(() => controlPlane.modelUsage.checkCap(ada.userId))
      .toMatchObject({ isReached: true });
    const second = await callModelProxy(
      controlPlane,
      access,
      relayedFormatExamples.anthropic,
      "Hi",
    );
    const client = await controlPlane.connectClient(thread.threadId, 0, adaToken);
    client.sendUserMessage("Carry on");
    const rejection = await client.inbox.waitFor(
      "the refusal",
      (message) => message.type === "client_message_rejected",
    );

    expect(lowerCap.status).toBe(200);
    expect(aboveInstallation.status).toBe(400);
    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({
      type: "error",
      error: { type: "permission_error", message: expect.stringContaining("model usage cap") },
    });
    expect(JSON.stringify(rejection)).toContain("model usage cap");
    expect(modelServer.receivedRequests).toHaveLength(1);
  });

  it("lets only the thread's own token spend its allowance, so nobody else can lock its agent out", async () => {
    await start();
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { access } = await startThread(adaToken, "anthropic/a-model");
    const anthropic = relayedFormatExamples.anthropic;
    const wellFormedButWrong = "A".repeat(43);

    const strangers: number[] = [];
    for (const token of [...Array(25).fill(""), ...Array(25).fill(wellFormedButWrong)]) {
      const refused = await callModelProxy(controlPlane, { ...access, token }, anthropic, "Hi");
      await refused.arrayBuffer();
      strangers.push(refused.status);
    }
    const agents = await callModelProxy(controlPlane, access, anthropic, "Say hello");
    await readWholeAnswer(agents);

    expect(new Set(strangers)).toEqual(new Set([403]));
    expect(agents.status).toBe(200);
  });

  it("lets a token accepted moments ago through without the lookups that strangers can use up", async () => {
    await start({
      modelProxyLimits: { authenticationBurst: 1, authenticationsPerSecond: 0.001 },
    });
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { thread, access } = await startThread(adaToken, "anthropic/a-model");
    const anthropic = relayedFormatExamples.anthropic;
    const first = await callModelProxy(controlPlane, access, anthropic, "Hi");
    await readWholeAnswer(first);

    const stranger = await callModelProxy(
      controlPlane,
      { ...access, token: "A".repeat(43) },
      anthropic,
      "Hi",
    );
    await stranger.arrayBuffer();
    const again = await callModelProxy(controlPlane, access, anthropic, "Hi again");
    await readWholeAnswer(again);
    await controlPlane.sendApi("POST", buildStopThreadApiPath(thread.threadId), adaToken);
    const afterTheStop = await callModelProxy(controlPlane, access, anthropic, "Hi");
    await afterTheStop.arrayBuffer();

    expect([first.status, stranger.status, again.status]).toEqual([200, 503, 200]);
    expect(afterTheStop.status).not.toBe(200);
  });

  it("keeps letting in an agent at work while strangers spend the lookups, however long it works", async () => {
    const clock = new ControllableClock();
    await start({
      clock: clock.now,
      modelProxyLimits: { authenticationBurst: 1, authenticationsPerSecond: 0.001 },
    });
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { access } = await startThread(adaToken, "anthropic/a-model");
    const anthropic = relayedFormatExamples.anthropic;
    const statuses: number[] = [];

    // A request every ten seconds for most of a minute, strangers spending the lookups between them.
    for (let step = 0; step < 6; step += 1) {
      const response = await callModelProxy(controlPlane, access, anthropic, "Hi");
      await readWholeAnswer(response);
      statuses.push(response.status);
      const stranger = await callModelProxy(
        controlPlane,
        { ...access, token: "A".repeat(43) },
        anthropic,
        "Hi",
      );
      await stranger.arrayBuffer();
      clock.advanceBy(10_000);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it("keeps letting in an agent while strangers spend the lookups, after a request longer than a token is remembered", {
    timeout: 20_000,
  }, async () => {
    const clock = new ControllableClock();
    await start({
      clock: clock.now,
      modelProxyLimits: { authenticationBurst: 1, authenticationsPerSecond: 0.001 },
    });
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { access } = await startThread(adaToken, "anthropic/a-model");
    const anthropic = relayedFormatExamples.anthropic;
    const first = await callModelProxy(controlPlane, access, anthropic, "Hi");
    await readWholeAnswer(first);
    clock.advanceBy(10_000);

    const long = await callModelProxy(controlPlane, access, anthropic, mockModelTriggers.slowReply);
    clock.advanceBy(40_000);
    await readWholeAnswer(long);
    const stranger = await callModelProxy(
      controlPlane,
      { ...access, token: "A".repeat(43) },
      anthropic,
      "Hi",
    );
    await stranger.arrayBuffer();
    clock.advanceBy(1_000);
    const next = await callModelProxy(controlPlane, access, anthropic, "And then");
    await readWholeAnswer(next);

    expect([first.status, long.status, stranger.status, next.status]).toEqual([200, 200, 503, 200]);
  });

  it("refuses a token remembered here once a lookup no longer finds it, as when the other instance revoked it", async () => {
    const clock = new ControllableClock();
    const tokenStore = new InMemoryModelProxyTokenStore();
    await start({ clock: clock.now, modelProxyTokenStore: tokenStore });
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { thread, access } = await startThread(adaToken, "anthropic/a-model");
    const anthropic = relayedFormatExamples.anthropic;
    const first = await callModelProxy(controlPlane, access, anthropic, "Hi");
    await readWholeAnswer(first);

    await tokenStore.revokeThread(thread.threadId);
    clock.advanceBy(16_000);
    const afterwards = await callModelProxy(controlPlane, access, anthropic, "Hi again");
    await afterwards.arrayBuffer();

    expect([first.status, afterwards.status]).toEqual([200, 403]);
  });

  it("looks a remembered token up again once at a time, however many of its requests arrive due for it", async () => {
    const clock = new ControllableClock();
    const tokenStore = new CountingTokenStore();
    await start({ clock: clock.now, modelProxyTokenStore: tokenStore });
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { access } = await startThread(adaToken, "anthropic/a-model");
    const anthropic = relayedFormatExamples.anthropic;
    await readWholeAnswer(await callModelProxy(controlPlane, access, anthropic, "Hi"));
    clock.advanceBy(16_000);
    tokenStore.reset();
    const lookup = tokenStore.holdLookups();

    const requests = Array.from({ length: 100 }, () =>
      callModelProxy(controlPlane, access, anthropic, "Hi").then(async (response) => {
        await response.arrayBuffer();
        return response.status;
      }),
    );
    await lookup.reached;
    // Give every other request time to arrive and find the lookup under way.
    await new Promise((resolve) => setTimeout(resolve, 300));
    lookup.release();
    const statuses = await Promise.all(requests);

    expect(tokenStore.peakLookupsAtOnce).toBe(1);
    expect(tokenStore.lookups).toBe(1);
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(4);
    expect(statuses.every((status) => status === 200 || status === 429)).toBe(true);
  });

  it("bounds how many token lookups callers not yet authenticated cause, whatever thread they name", async () => {
    await start({ modelProxyLimits: { authenticationBurst: 5, authenticationsPerSecond: 1 } });
    const statuses: number[] = [];

    for (let index = 0; index < 20; index += 1) {
      const madeUpThreadId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const response = await fetch(
        `${controlPlane.httpBaseUrl}/threads/${madeUpThreadId}/model-proxy/anthropic/v1/messages`,
        { method: "POST", headers: { "x-api-key": "A".repeat(43) }, body: "{}" },
      );
      await response.arrayBuffer();
      statuses.push(response.status);
    }

    expect(statuses.filter((status) => status === 403).length).toBeLessThanOrEqual(6);
    expect(statuses.filter((status) => status === 503).length).toBeGreaterThanOrEqual(14);
  });

  // The proxy relays only requests shaped like the pinned agent's: what it
  // never sends could be anything a provider adds next, billed or generated
  // where the cap cannot see it.
  it.each([
    ["a background response", "openai", { background: true }, {}, "the member `background`"],
    ["a deferred completion", "groq", { deferred: true }, {}, "the member `deferred`"],
    ["128 completions", "groq", { n: 128 }, {}, "the member `n`"],
    ["the priority tier", "openai", { service_tier: "priority" }, {}, "the member `service_tier`"],
    [
      "an earlier stored response",
      "openai",
      { previous_response_id: "resp_1" },
      {},
      "the member `previous_response_id`",
    ],
    [
      "a stored item",
      "openai",
      { input: [{ type: "item_reference", id: "msg_1" }] },
      {},
      "the conversation item type `item_reference`",
    ],
    [
      "a code interpreter with stored files",
      "openai",
      { tools: [{ type: "code_interpreter", container: { type: "auto", file_ids: ["file-1"] } }] },
      {},
      "the tool type `code_interpreter`",
    ],
    [
      "a document by its address",
      "anthropic",
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "document", source: { type: "url", url: "https://example.com/a.pdf" } },
            ],
          },
        ],
      },
      {},
      "the content part type `document`",
    ],
    ["a remote MCP server", "anthropic", { mcp_servers: [] }, {}, "the member `mcp_servers`"],
    [
      "an advisor running another model",
      "anthropic",
      { tools: [{ type: "advisor_20260301", name: "advisor", model: "the-dearest-model" }] },
      {},
      "the tool type `advisor_20260301`",
    ],
    [
      "compaction",
      "anthropic",
      { compaction: { type: "summarize" } },
      { "anthropic-beta": "compact-2026-09-04" },
      "the anthropic-beta value `compact-2026-09-04`",
    ],
    [
      "a thread continued on the provider",
      "anthropic",
      { thread: { type: "continue", previous_message_id: "msg_1" } },
      {},
      "the member `thread`",
    ],
  ] as const)(
    "refuses %s, which the agent never sends, naming it in words the agent shows",
    async (_description, providerId, holding, headers, what) => {
      await start();
      const ownersKey = {
        openai: keys.adasOpenAi,
        anthropic: keys.adasAnthropic,
        groq: keys.adasGroq,
      }[providerId];
      await controlPlane.saveModelCredential(providerId, ownersKey, adaToken);
      const { access } = await startThread(adaToken, `${providerId}/a-model`);
      const example = relayedFormatExamples[providerId];

      const response = await callModelProxy(controlPlane, access, example, "Go on", {
        headers,
        body: JSON.stringify({ ...example.body("Go on"), ...holding }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: `Barrack's model proxy does not relay ${what}: it relays only requests shaped like those of its coding agent.`,
        },
      });
      expect(modelServer.receivedRequests).toEqual([]);
      expect(controlPlane.logLines.join("\n")).toContain(JSON.stringify(what).slice(1, -1));
    },
  );

  it("relays only the thread's own model, and only the fallbacks the agent sends for that model", async () => {
    await start();
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const anthropicModelIds =
      findCatalogueProvider("anthropic")?.models.map((m) => m.modelId) ?? [];
    const fallbacksOf = (modelId: string) =>
      findModelLimits("anthropic", modelId)?.fallbackModelIds ?? [];
    // A model with fallbacks, and another model's list naming one its own does not.
    const lists = anthropicModelIds.map(fallbacksOf).filter((fallbacks) => fallbacks.length > 0);
    const namesAnother = (list: readonly string[], modelId: string) =>
      list.some((fallback) => !fallbacksOf(modelId).includes(fallback));
    const withFallbacks =
      anthropicModelIds.find(
        (modelId) =>
          fallbacksOf(modelId).length > 0 && lists.some((list) => namesAnother(list, modelId)),
      ) ?? "";
    const otherFallbacks = lists.find((list) => namesAnother(list, withFallbacks)) ?? [];
    const { access } = await startThread(adaToken, `anthropic/${withFallbacks}`);
    const anthropic = relayedFormatExamples.anthropic;
    const asking = (overrides: object) =>
      callModelProxy(controlPlane, access, anthropic, "Hi", {
        body: JSON.stringify({ ...anthropic.body("Hi"), model: withFallbacks, ...overrides }),
      });
    const asList = (models: readonly string[]) => models.map((model) => ({ model }));

    const otherModel = await asking({ model: "the-dearest-model" });
    // A list the agent sends, but for another model.
    const anotherModelsFallbacks = await asking({ fallbacks: asList(otherFallbacks) });
    const unlistedFallback = await asking({ fallbacks: asList(["the-dearest-model"]) });
    const ownModelsFallbacks = await asking({ fallbacks: asList(fallbacksOf(withFallbacks)) });
    await readWholeAnswer(ownModelsFallbacks);

    expect(otherFallbacks.length).toBeGreaterThan(0);
    for (const refused of [otherModel, anotherModelsFallbacks]) {
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: {
          message: expect.stringContaining(`only for its own model, "anthropic/${withFallbacks}"`),
        },
      });
    }
    expect(unlistedFallback.status).toBe(400);
    expect(ownModelsFallbacks.status).toBe(200);
    expect(modelServer.receivedModels).toEqual([withFallbacks]);
  });

  it("relays OpenRouter's requests only for the thread's own model, without its routing or plugins", async () => {
    await start();
    await controlPlane.saveModelCredential("openrouter", keys.adasOpenRouter, adaToken);
    const { access } = await startThread(adaToken, "openrouter/anthropic/example-model");
    const model = "anthropic/example-model";
    const chat = (fields: object) =>
      callModelProxy(controlPlane, access, relayedFormatExamples.groq, "", {
        apiPath: "/chat/completions",
        body: JSON.stringify({ ...relayedFormatExamples.groq.body("Hi"), model, ...fields }),
      });
    const messages = (fields: object) =>
      callModelProxy(controlPlane, access, relayedFormatExamples.anthropic, "", {
        apiPath: "/v1/messages",
        headers: { "x-api-key": "", authorization: `Bearer ${access.token}` },
        body: JSON.stringify({ ...relayedFormatExamples.anthropic.body("Hi"), model, ...fields }),
      });

    const notTheAgents = [
      await chat({ models: [model, "openai/the-dearest-model"] }),
      await chat({ route: "fallback" }),
      await chat({ preset: "@preset/anything" }),
      await chat({ provider: { options: { anthropic: { model: "the-dearest-model" } } } }),
      await chat({ provider: { order: ["a-host"] } }),
      await chat({ plugins: [{ id: "web" }] }),
      await messages({ fallbacks: [{ model: "openai/the-dearest-model" }] }),
    ];
    const otherModels = [
      await chat({ model: `${model}@preset/anything` }),
      await chat({ model: `${model}:nitro` }),
    ];
    const allowed = [await chat({}), await messages({})];

    expect(notTheAgents.map((response) => response.status)).toEqual(Array(7).fill(400));
    expect(otherModels.map((response) => response.status)).toEqual([403, 403]);
    for (const response of allowed) {
      await readWholeAnswer(response);
    }
    expect(allowed.map((response) => response.status)).toEqual([200, 200]);
    expect(modelServer.receivedModels).toEqual([model, model]);
  });

  it("keeps the model before a switch usable for the run then open, and for no later run", async () => {
    await start();
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    await controlPlane.saveModelCredential("openai", keys.adasOpenAi, adaToken);
    const { thread, supervisor, access } = await startThread(adaToken, "anthropic/a-model");
    const anthropic = relayedFormatExamples.anthropic;
    const run = runEventsOf(supervisor);
    await run.send({ type: "agent_run_started" });

    await switchModel(thread.threadId, "openai/a-model");
    const duringTheRun = await callModelProxy(controlPlane, access, anthropic, "Go on");
    await readWholeAnswer(duringTheRun);
    await run.send({ type: "agent_run_settled", wasInterrupted: false });
    await run.send({ type: "agent_run_started" });
    const inTheNextRun = await callModelProxy(controlPlane, access, anthropic, "Go on");

    expect(duringTheRun.status).toBe(200);
    expect(inTheNextRun.status).toBe(403);
    expect(
      await controlPlane.modelProxyTokens.isAccepted(thread.threadId, "anthropic", access.token),
    ).toBe(false);
  });

  it("retires a provider's tokens at a switch with no run open, and mints new ones on switching back", async () => {
    await start();
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    await controlPlane.saveModelCredential("openai", keys.adasOpenAi, adaToken);
    const { thread, supervisor, access } = await startThread(adaToken, "anthropic/a-model");

    await switchModel(thread.threadId, "openai/a-model");
    const afterSwitching = await callModelProxy(
      controlPlane,
      access,
      relayedFormatExamples.anthropic,
      "Hi",
    );
    supervisor.inbox.messages.splice(0);
    await switchModel(thread.threadId, "anthropic/a-model");
    const newAccess = await waitForProxyAccess(supervisor, "anthropic");
    const afterSwitchingBack = await callModelProxy(
      controlPlane,
      newAccess,
      relayedFormatExamples.anthropic,
      "Hi",
    );
    await readWholeAnswer(afterSwitchingBack);

    expect(afterSwitching.status).toBe(403);
    expect(newAccess.token).not.toBe(access.token);
    expect(afterSwitchingBack.status).toBe(200);
  });

  it("never relays a model from before the previous one, nor the previous one past its time", async () => {
    const clock = new ControllableClock();
    await start({ clock: clock.now });
    for (const [providerId, key] of [
      ["anthropic", keys.adasAnthropic],
      ["openai", keys.adasOpenAi],
      ["groq", keys.adasGroq],
    ] as const) {
      await controlPlane.saveModelCredential(providerId, key, adaToken);
    }
    const { thread, supervisor, access } = await startThread(adaToken, "anthropic/a-model");
    const run = runEventsOf(supervisor);
    await run.send({ type: "agent_run_started" });
    await switchModel(thread.threadId, "openai/a-model");
    const openAiAccess = await waitForProxyAccess(supervisor, "openai");
    await run.send({ type: "agent_run_settled", wasInterrupted: false });
    await run.send({ type: "agent_run_started" });

    await switchModel(thread.threadId, "groq/a-model");
    const beforeThePrevious = await callModelProxy(
      controlPlane,
      access,
      relayedFormatExamples.anthropic,
      "Hi",
    );
    const previous = await callModelProxy(
      controlPlane,
      openAiAccess,
      relayedFormatExamples.openai,
      "Hi",
    );
    await readWholeAnswer(previous);
    clock.advanceBy(previousModelAllowedForInMilliseconds + 1);
    const previousPastItsTime = await callModelProxy(
      controlPlane,
      openAiAccess,
      relayedFormatExamples.openai,
      "Hi",
    );

    expect(beforeThePrevious.status).toBe(403);
    expect(previous.status).toBe(200);
    expect(previousPastItsTime.status).toBe(403);
  });

  it("refuses a second request at once from a thread allowed one", async () => {
    await start({ modelProxyLimits: { concurrentRequestsPerThread: 1 } });
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { access } = await startThread(adaToken, "anthropic/a-model");
    const anthropic = relayedFormatExamples.anthropic;
    const slow = await callModelProxy(controlPlane, access, anthropic, mockModelTriggers.slowReply);

    const second = await callModelProxy(controlPlane, access, anthropic, "Say hello");

    expect(slow.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("2");
    await slow.body?.cancel();
  });

  it("refuses a request body over the limit, whether or not it says its length", async () => {
    await start({ modelProxyLimits: { maximumRequestBytes: 1_000 } });
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { access } = await startThread(adaToken, "anthropic/a-model");
    const anthropic = relayedFormatExamples.anthropic;
    const largeText = "x".repeat(2_000);
    const chunked = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(anthropic.body(largeText))));
        controller.close();
      },
    });

    const declared = await callModelProxy(controlPlane, access, anthropic, largeText);
    const undeclared = await callModelProxy(controlPlane, access, anthropic, "", { body: chunked });

    expect(declared.status).toBe(413);
    expect(undeclared.status).toBe(413);
  });

  it("ends an answer that outlasts the time allowed, and counts what was generated as estimated", async () => {
    await start({ modelProxyLimits: { totalTimeoutInMilliseconds: 700 } });
    await controlPlane.saveModelCredential("anthropic", keys.adasAnthropic, adaToken);
    const { thread, access } = await startThread(adaToken, "anthropic/a-model");

    const response = await callModelProxy(
      controlPlane,
      access,
      relayedFormatExamples.anthropic,
      mockModelTriggers.slowReply,
    );
    await expect(response.text()).rejects.toThrow();

    await expect
      .poll(() => controlPlane.modelUsage.listForThread(ada.userId, thread.threadId))
      .toEqual([
        expect.objectContaining({
          source: "estimated",
          inputTokens: expect.any(Number),
          outputTokens: expect.any(Number),
        }),
      ]);
    const [estimate] = await controlPlane.modelUsage.listForThread(ada.userId, thread.threadId);
    expect(estimate?.outputTokens).toBeGreaterThan(0);
    // The input is Anthropic's own count from `message_start`, not an estimate.
    expect(estimate?.inputTokens).toBeGreaterThan(0);
  });

  it("cancels the provider's request when the agent hangs up, and estimates what it generated", async () => {
    await start();
    await controlPlane.saveModelCredential("openai", keys.adasOpenAi, adaToken);
    const { thread, access } = await startThread(adaToken, "openai/a-model");
    const hangUp = new AbortController();

    const response = await callModelProxy(
      controlPlane,
      access,
      relayedFormatExamples.openai,
      mockModelTriggers.slowReply,
      { signal: hangUp.signal },
    );
    const reader = response.body?.getReader();
    await reader?.read();
    await new Promise((resolve) => setTimeout(resolve, 300));
    hangUp.abort();

    await expect.poll(() => modelServer.receivedRequests[0]?.wasAbandoned).toBe(true);
    await expect
      .poll(() => controlPlane.modelUsage.listForThread(ada.userId, thread.threadId))
      .toEqual([expect.objectContaining({ source: "estimated", answerCount: 1 })]);
  });
});
