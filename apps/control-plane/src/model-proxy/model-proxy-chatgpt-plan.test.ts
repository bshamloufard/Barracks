import { FakeChatGptSignIn } from "@barrack/fake-chatgpt-sign-in";
import {
  type MockModelServer,
  mockModelTriggers,
  startMockModelServer,
} from "@barrack/mock-model-server";
import {
  type AgentEvent,
  buildThreadModelUsageApiPath,
  type ConfigureModelAccess,
  chatGptPlanApiPath,
  chatGptPlanOpenAiAccessApiPath,
  chatGptPlanSignInApiPath,
  chatGptPlanSignInCompletionApiPath,
  chatGptPlanSignInStartSchema,
  type ProviderAccess,
  threadModelUsageResponseSchema,
} from "@barrack/protocol";
import { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  callModelProxy,
  type ProxyAccess,
  relayedFormatExamples,
  waitForProxyAccess,
} from "../test-support/model-proxy-peers.js";
import { TestControlPlane, type TestThread } from "../test-support/test-control-plane.js";
import type { FakeSupervisor } from "../test-support/test-peers.js";

/**
 * The model proxy spending a user's ChatGPT plan rather than an API key,
 * through the real control plane, in front of the mock model server
 * answering as OpenAI's "Sign in with ChatGPT" programme does, with the
 * plan connected through a stand-in for OpenAI's sign-in. Two users sign
 * in with tokens from a test identity issuer.
 */

const ada = { userId: "11111111-1111-4111-8111-111111111111", email: "ada@example.com" };
const grace = { userId: "22222222-2222-4222-8222-222222222222", email: "grace@example.com" };
const gracesOpenAiKey = "fake-openai-key-of-grace-0001";
const planModel = "openai/gpt-6.1-sol";

let identityIssuer: TestIdentityIssuer;
let signInServer: FakeChatGptSignIn;
let modelServer: MockModelServer;
let controlPlane: TestControlPlane;
let adaToken: string;
let graceToken: string;
/** Access tokens the stand-in for OpenAI's API refuses whatever the sign-in says, as an invalidated token is. */
let refusedPlanTokens: Set<string>;
let refusesEveryPlanToken: boolean;

beforeEach(async () => {
  identityIssuer = await TestIdentityIssuer.start();
  signInServer = await FakeChatGptSignIn.start();
  signInServer.addAccount({
    subject: "chatgpt-ada",
    email: "ada@chatgpt.example",
    isEligible: true,
  });
  refusedPlanTokens = new Set();
  refusesEveryPlanToken = false;
  modelServer = await startMockModelServer("127.0.0.1", {
    checkPlanToken: (token) =>
      refusesEveryPlanToken || refusedPlanTokens.has(token)
        ? { kind: "revoked" }
        : signInServer.checkAccessToken(token),
  });
  controlPlane = await TestControlPlane.start({
    authentication: { kind: "test-issuer", issuer: identityIssuer },
    chatGptPlan: { signInIssuer: signInServer.issuer },
    modelProxyUpstreamOrigin: modelServer.origin,
  });
  adaToken = await identityIssuer.mintAccessToken(ada);
  graceToken = await identityIssuer.mintAccessToken(grace);
  await connectAdasPlan();
});

afterEach(async () => {
  await controlPlane.close();
  await modelServer.close();
  await signInServer.close();
  await identityIssuer.close();
});

async function connectAdasPlan(): Promise<void> {
  const started = await controlPlane.sendJson(
    "POST",
    chatGptPlanSignInApiPath,
    { allowsBackgroundUse: true },
    adaToken,
  );
  const { authorizationUrl } = chatGptPlanSignInStartSchema.parse(await started.json());
  const finished = await controlPlane.sendJson(
    "POST",
    chatGptPlanSignInCompletionApiPath,
    { finalAddress: signInServer.approve(authorizationUrl, "chatgpt-ada") },
    adaToken,
  );
  expect(finished.status).toBe(200);
}

async function adasPlanAccessToken(): Promise<string> {
  const token = await controlPlane.chatGptPlan.findAccessToken(ada.userId);
  if (token.kind !== "token") {
    throw new Error("Ada's plan is not connected.");
  }
  return token.accessToken;
}

async function startThread(
  userToken: string,
): Promise<{ thread: TestThread; supervisor: FakeSupervisor; access: ProxyAccess }> {
  const thread = await controlPlane.createThread(userToken, planModel);
  const supervisor = await controlPlane.connectSupervisor(thread);
  return { thread, supervisor, access: await waitForProxyAccess(supervisor, "openai") };
}

/** A request as the agent sends it on a plan: no member the programme refuses. */
function planShapedBody(text: string, extra: object = {}): string {
  return JSON.stringify({
    model: "gpt-6.1-sol",
    store: false,
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text }] }],
    ...extra,
  });
}

function callOnPlan(access: ProxyAccess, body: string): Promise<Response> {
  return callModelProxy(controlPlane, access, relayedFormatExamples.openai, "", { body });
}

describe("the model proxy on a ChatGPT plan", () => {
  it("tells the sandbox it spends the plan, giving it a proxy token and nothing of the plan's", async () => {
    const { supervisor } = await startThread(adaToken);

    const configured = supervisor.inbox.messages.filter(
      (message): message is ConfigureModelAccess => message.type === "configure_model_access",
    );
    expect(configured.at(-1)?.credential).toMatchObject({
      kind: "proxy_token",
      access: "chatgpt_plan",
    });
    expect(JSON.stringify(supervisor.inbox.messages)).not.toContain(await adasPlanAccessToken());
  });

  it("relays the thread's requests with the plan's access token, which never comes back", async () => {
    const { access } = await startThread(adaToken);

    const response = await callOnPlan(access, planShapedBody("Say hello"));

    const answer = await response.text();
    const [received] = modelServer.receivedRequests;
    expect(response.status).toBe(200);
    expect(received?.target).toBe("/v1/responses");
    expect(received?.credential).toBe(await adasPlanAccessToken());
    expect(received?.planAccount).toBe("chatgpt-ada");
    expect(answer).not.toContain(await adasPlanAccessToken());
  });

  it("measures what the plan's answers used, as for any relayed request", async () => {
    const { thread, access } = await startThread(adaToken);
    await (await callOnPlan(access, planShapedBody("Say hello"))).text();

    const usage = threadModelUsageResponseSchema.parse(
      await (
        await controlPlane.getApi(buildThreadModelUsageApiPath(thread.threadId), adaToken)
      ).json(),
    );

    expect(usage.byModel).toEqual([
      expect.objectContaining({ providerId: "openai", modelId: "gpt-6.1-sol", source: "measured" }),
    ]);
  });

  it.each([
    ["max_output_tokens", { max_output_tokens: 1000 }],
    ["prompt_cache_retention", { prompt_cache_retention: "24h" }],
  ])(
    "refuses a request holding %s, which the plan refuses and the agent sends only on a key",
    async (member, extra) => {
      const { access } = await startThread(adaToken);

      const response = await callOnPlan(access, planShapedBody("Say hello", extra));

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(`the member \`${member}\``);
      expect(modelServer.receivedRequests).toEqual([]);
    },
  );

  it("spends another user's own key on their thread, never the plan of the user who connected one", async () => {
    await controlPlane.saveModelCredential("openai", gracesOpenAiKey, graceToken);
    const { supervisor, access } = await startThread(graceToken);

    const response = await callModelProxy(
      controlPlane,
      access,
      relayedFormatExamples.openai,
      "Hi",
      {
        body: JSON.stringify({ ...relayedFormatExamples.openai.body("Hi"), model: "gpt-6.1-sol" }),
      },
    );

    await response.text();
    const configured = supervisor.inbox.messages.filter(
      (message): message is ConfigureModelAccess => message.type === "configure_model_access",
    );
    expect(configured.at(-1)?.credential).toMatchObject({ access: "api_key" });
    expect(modelServer.receivedRequests.map((request) => request.credential)).toEqual([
      gracesOpenAiKey,
    ]);
  });

  it("answers a refused token with the plan's own refusal, to connect again, once OpenAI will not renew it", async () => {
    const { access } = await startThread(adaToken);
    signInServer.revokeEverySignInOf("chatgpt-ada");

    const refused = await callOnPlan(access, planShapedBody("Say hello"));

    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("ChatGPT plan is not connected to Barrack");
    expect(signInServer.refreshAttempts).toEqual([{ outcome: "refused" }]);
    expect((await controlPlane.chatGptPlan.describe(ada.userId)).loss?.reason).toBe(
      "sign_in_expired",
    );
  });

  it("passes the plan's usage limit through, for the agent to report", async () => {
    const { access } = await startThread(adaToken);
    modelServer.setPlanSpent("chatgpt-ada", true);

    const response = await callOnPlan(access, planShapedBody("Say hello"));

    expect(response.status).toBe(429);
    expect(await response.text()).toContain("subscription_sharing_usage_limit_exceeded");
  });
});

/** The mock's slow reply takes five seconds. */
const slowReplyTimeoutInMilliseconds = 15_000;

describe("a request in flight on a ChatGPT plan, checked again", () => {
  /** Access tokens that last a minute are always within the renewal margin. */
  async function startWithTokensAlwaysDueForRenewal(): Promise<ProxyAccess> {
    await controlPlane.close();
    await signInServer.close();
    signInServer = await FakeChatGptSignIn.start({ accessTokenLifetimeInSeconds: 60 });
    signInServer.addAccount({
      subject: "chatgpt-ada",
      email: "ada@chatgpt.example",
      isEligible: true,
    });
    controlPlane = await TestControlPlane.start({
      authentication: { kind: "test-issuer", issuer: identityIssuer },
      chatGptPlan: { signInIssuer: signInServer.issuer },
      modelProxyUpstreamOrigin: modelServer.origin,
      modelProxyLimits: { reauthorizationIntervalInMilliseconds: 100 },
    });
    await connectAdasPlan();
    return (await startThread(adaToken)).access;
  }

  it(
    "carries on when its plan is due for renewal and OpenAI cannot renew it just now",
    async () => {
      const access = await startWithTokensAlwaysDueForRenewal();
      const inFlight = await callOnPlan(
        access,
        planShapedBody(`Please ${mockModelTriggers.slowReply}`),
      );
      expect(inFlight.status).toBe(200);

      signInServer.failTokenRequestsWithStatus = 503;

      expect(await inFlight.text()).toContain("word49");
    },
    slowReplyTimeoutInMilliseconds,
  );

  it(
    "does not renew the plan while it waits for the answer",
    async () => {
      const access = await startWithTokensAlwaysDueForRenewal();
      const inFlight = await callOnPlan(
        access,
        planShapedBody(`Please ${mockModelTriggers.slowReply}`),
      );
      const renewalsBefore = signInServer.refreshAttempts.length;

      await inFlight.text();

      expect(signInServer.refreshAttempts.length).toBe(renewalsBefore);
    },
    slowReplyTimeoutInMilliseconds,
  );

  it("is ended soon after the plan is disconnected", async () => {
    const access = await startWithTokensAlwaysDueForRenewal();
    const inFlight = await callOnPlan(
      access,
      planShapedBody(`Please ${mockModelTriggers.slowReply}`),
    );
    expect(inFlight.status).toBe(200);

    await controlPlane.sendJson("DELETE", chatGptPlanApiPath, {}, adaToken);

    await expect(inFlight.text()).rejects.toThrow();
  });
});

/** Sends a supervisor's agent events one at a time, each recorded before the next. */
function runEventsOf(supervisor: FakeSupervisor) {
  let eventNumber = 0;
  return async (event: AgentEvent): Promise<void> => {
    eventNumber += 1;
    supervisor.sendAgentEventNumbered(eventNumber, event);
    await supervisor.waitUntilRecorded(eventNumber);
  };
}

async function chooseOpenAiAccess(access: ProviderAccess): Promise<void> {
  const response = await controlPlane.sendJson(
    "PUT",
    chatGptPlanOpenAiAccessApiPath,
    { access },
    adaToken,
  );
  expect(response.status).toBe(200);
}

describe("a run open when its owner changes what OpenAI models spend", () => {
  const adasOpenAiKey = "fake-openai-key-of-ada-0001";
  const keyShapedBody = JSON.stringify({
    ...relayedFormatExamples.openai.body("Go on"),
    model: "gpt-6.1-sol",
  });

  it("carries on spending what it began with, and the next run spends the new choice", async () => {
    await controlPlane.saveModelCredential("openai", adasOpenAiKey, adaToken);
    const { supervisor, access } = await startThread(adaToken);
    const sendAgentEvent = runEventsOf(supervisor);
    const planAccessToken = await adasPlanAccessToken();
    await sendAgentEvent({ type: "agent_run_started" });

    await chooseOpenAiAccess("api_key");
    const duringTheRun = await callOnPlan(access, planShapedBody("Go on"));
    await duringTheRun.text();
    await sendAgentEvent({ type: "agent_run_settled", wasInterrupted: false });
    await sendAgentEvent({ type: "agent_run_started" });
    const inTheNextRun = await callOnPlan(access, keyShapedBody);
    await inTheNextRun.text();

    expect([duringTheRun.status, inTheNextRun.status]).toEqual([200, 200]);
    expect(modelServer.receivedRequests.map((request) => request.credential)).toEqual([
      planAccessToken,
      adasOpenAiKey,
    ]);
  });

  it("keeps spending the key for the run open when the plan is chosen during it", async () => {
    await controlPlane.saveModelCredential("openai", adasOpenAiKey, adaToken);
    await chooseOpenAiAccess("api_key");
    const { supervisor, access } = await startThread(adaToken);
    await runEventsOf(supervisor)({ type: "agent_run_started" });

    await chooseOpenAiAccess("chatgpt_plan");
    const duringTheRun = await callOnPlan(access, keyShapedBody);
    await duringTheRun.text();

    expect(duringTheRun.status).toBe(200);
    expect(modelServer.receivedRequests.map((request) => request.credential)).toEqual([
      adasOpenAiKey,
    ]);
  });
});

describe("a ChatGPT plan's access token refused by OpenAI", () => {
  it("is renewed, and the request sent again with the new token, the agent seeing only the answer", async () => {
    const { access } = await startThread(adaToken);
    const refusedToken = await adasPlanAccessToken();
    refusedPlanTokens.add(refusedToken);

    const response = await callOnPlan(access, planShapedBody("Say hello"));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Hello");
    const renewedToken = await adasPlanAccessToken();
    expect(modelServer.receivedRequests.map((request) => request.credential)).toEqual([
      refusedToken,
      renewedToken,
    ]);
    expect(signInServer.refreshAttempts).toEqual([{ outcome: "renewed" }]);
  });

  it("is renewed once however many requests it was refused for at once", async () => {
    const { access } = await startThread(adaToken);
    refusedPlanTokens.add(await adasPlanAccessToken());

    const responses = await Promise.all(
      [1, 2, 3].map(() => callOnPlan(access, planShapedBody("Say hello"))),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    await Promise.all(responses.map((response) => response.text()));
    expect(signInServer.refreshAttempts).toEqual([{ outcome: "renewed" }]);
  });

  it("is answered as the plan's sign-in refused, never as an API key, when the renewed token is refused too", async () => {
    const { access } = await startThread(adaToken);
    refusesEveryPlanToken = true;

    const response = await callOnPlan(access, planShapedBody("Say hello"));

    expect(response.status).toBe(401);
    const answer = await response.text();
    expect(answer).toContain("did not accept your ChatGPT plan's sign-in");
    expect(answer).not.toContain("subscription_sharing_invalid_user");
    expect(modelServer.receivedRequests).toHaveLength(2);
  });

  it("is not renewed before OpenAI allows it, the request answered as the plan's sign-in refused", async () => {
    await controlPlane.close();
    await signInServer.close();
    signInServer = await FakeChatGptSignIn.start({ earliestRefreshDelayInSeconds: 600 });
    signInServer.addAccount({
      subject: "chatgpt-ada",
      email: "ada@chatgpt.example",
      isEligible: true,
    });
    controlPlane = await TestControlPlane.start({
      authentication: { kind: "test-issuer", issuer: identityIssuer },
      chatGptPlan: { signInIssuer: signInServer.issuer },
      modelProxyUpstreamOrigin: modelServer.origin,
    });
    await connectAdasPlan();
    const { access } = await startThread(adaToken);
    refusedPlanTokens.add(await adasPlanAccessToken());

    const response = await callOnPlan(access, planShapedBody("Say hello"));

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("did not accept your ChatGPT plan's sign-in");
    expect(signInServer.refreshAttempts).toEqual([]);
  });
});
