import { FakeChatGptSignIn } from "@barrack/fake-chatgpt-sign-in";
import { type MockModelServer, startMockModelServer } from "@barrack/mock-model-server";
import {
  type ApiErrorResponse,
  chatGptPlanApiPath,
  chatGptPlanDisconnectionSchema,
  chatGptPlanModelListSchema,
  chatGptPlanModelsApiPath,
  chatGptPlanOpenAiAccessApiPath,
  chatGptPlanSignInApiPath,
  chatGptPlanSignInCompletionApiPath,
  chatGptPlanSignInStartSchema,
  chatGptPlanStatusSchema,
} from "@barrack/protocol";
import { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialKeyring } from "../model-access/credential-keyring.js";
import { TestControlPlane } from "../test-support/test-control-plane.js";
import { InMemoryThreadStore } from "../threads/in-memory-thread-store.js";
import { ChatGptPlanAccess } from "./chatgpt-plan-access.js";
import { ChatGptSignInClient } from "./chatgpt-sign-in-client.js";
import { InMemoryChatGptPlanStore } from "./in-memory-chatgpt-plan-store.js";

/**
 * Connecting a ChatGPT plan through the control plane's API, against a
 * stand-in for OpenAI's sign-in that answers as its documentation says,
 * signed in as real users through a test identity issuer.
 */

const ada = { userId: "11111111-1111-4111-8111-111111111111", email: "ada@example.com" };
const grace = { userId: "22222222-2222-4222-8222-222222222222", email: "grace@example.com" };

let identityIssuer: TestIdentityIssuer;
let signInServer: FakeChatGptSignIn;
let modelServer: MockModelServer;
let store: InMemoryChatGptPlanStore;
let controlPlane: TestControlPlane;
let adaToken: string;
let graceToken: string;

beforeEach(async () => {
  identityIssuer = await TestIdentityIssuer.start();
  signInServer = await FakeChatGptSignIn.start();
  signInServer.addAccount({
    subject: "chatgpt-ada",
    email: "ada@chatgpt.example",
    isEligible: true,
  });
  signInServer.addAccount({
    subject: "chatgpt-grace",
    email: "grace@chatgpt.example",
    isEligible: true,
  });
  modelServer = await startMockModelServer("127.0.0.1", {
    checkPlanToken: (token) => signInServer.checkAccessToken(token),
  });
  store = new InMemoryChatGptPlanStore(new CredentialKeyring(Buffer.alloc(32, 7)));
  controlPlane = await TestControlPlane.start({
    authentication: { kind: "test-issuer", issuer: identityIssuer },
    chatGptPlan: { signInIssuer: signInServer.issuer },
    chatGptPlanStore: store,
    modelProxyUpstreamOrigin: modelServer.origin,
  });
  adaToken = await identityIssuer.mintAccessToken(ada);
  graceToken = await identityIssuer.mintAccessToken(grace);
});

afterEach(async () => {
  await controlPlane.close();
  await modelServer.close();
  await signInServer.close();
  await identityIssuer.close();
});

async function beginSignIn(accessToken: string): Promise<string> {
  const response = await controlPlane.sendJson(
    "POST",
    chatGptPlanSignInApiPath,
    { allowsBackgroundUse: true },
    accessToken,
  );
  expect(response.status).toBe(200);
  return chatGptPlanSignInStartSchema.parse(await response.json()).authorizationUrl;
}

function finishSignIn(accessToken: string, finalAddress: string): Promise<Response> {
  return controlPlane.sendJson(
    "POST",
    chatGptPlanSignInCompletionApiPath,
    { finalAddress },
    accessToken,
  );
}

async function connect(accessToken: string, subject: string): Promise<void> {
  const finalAddress = signInServer.approve(await beginSignIn(accessToken), subject);
  expect((await finishSignIn(accessToken, finalAddress)).status).toBe(200);
}

async function readStatus(accessToken: string) {
  const response = await controlPlane.getApi(chatGptPlanApiPath, accessToken);
  expect(response.status).toBe(200);
  return chatGptPlanStatusSchema.parse(await response.json());
}

async function readRefusal(response: Response): Promise<ApiErrorResponse["error"]> {
  return ((await response.json()) as ApiErrorResponse).error;
}

describe("connecting a ChatGPT plan", () => {
  it("asks OpenAI for everything its sign-in requires, registering the app on the first sign-in", async () => {
    const authorization = new URL(await beginSignIn(adaToken)).searchParams;

    expect(Object.fromEntries(authorization)).toEqual({
      response_type: "code",
      client_id: "dynamic_agent_client",
      agent_name_hint: "Barrack",
      ext_agent_host_id: expect.stringMatching(/^urn:uuid:[0-9a-f-]{36}$/),
      redirect_uri: "http://127.0.0.1:1455/auth/callback",
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      state: expect.stringMatching(/^[\w-]{43}$/),
      nonce: expect.stringMatching(/^[\w-]{43}$/),
      code_challenge: expect.stringMatching(/^[\w-]{43}$/),
      code_challenge_method: "S256",
    });
  });

  it("connects from the address the browser ended on, and runs the user's OpenAI models on it", async () => {
    await connect(adaToken, "chatgpt-ada");

    expect(await readStatus(adaToken)).toEqual({
      availability: "available",
      connection: { connectedAt: expect.any(String), accountEmail: "ada@chatgpt.example" },
      loss: null,
      openAiAccess: "chatgpt_plan",
    });
    expect(signInServer.registeredClients).toHaveLength(1);
  });

  it("signs in again with the client it registered and the same host, without registering anew", async () => {
    await connect(adaToken, "chatgpt-ada");
    const authorizationUrl = await beginSignIn(adaToken);
    const again = new URL(authorizationUrl).searchParams;
    const [registered] = signInServer.registeredClients;

    expect(again.get("client_id")).toBe(registered?.clientId);
    expect(again.get("ext_agent_host_id")).toBe(registered?.hostId);
    expect(again.has("agent_name_hint")).toBe(false);
    expect(again.get("login_hint")).toBe("ada@chatgpt.example");
    expect(again.has("id_token_hint")).toBe(false);
    const finalAddress = signInServer.approve(authorizationUrl, "chatgpt-ada");
    expect(new URL(finalAddress).searchParams.has("client_id")).toBe(false);
    expect((await finishSignIn(adaToken, finalAddress)).status).toBe(200);
    expect(signInServer.registeredClients).toHaveLength(1);
  });

  it("gives each user a host identifier of their own", async () => {
    const adaHost = new URL(await beginSignIn(adaToken)).searchParams.get("ext_agent_host_id");
    const graceHost = new URL(await beginSignIn(graceToken)).searchParams.get("ext_agent_host_id");

    expect(adaHost).not.toBe(graceHost);
  });

  it("does not begin without the user's consent to use the plan while they are away", async () => {
    const response = await controlPlane.sendJson("POST", chatGptPlanSignInApiPath, {}, adaToken);

    expect(response.status).toBe(400);
    expect((await readRefusal(response)).message).toContain("while you are away");
  });
});

describe("a pasted address that cannot finish a sign-in", () => {
  it.each([
    ["nothing", "", "Paste the address your browser ended on"],
    ["OpenAI's page itself", "AUTHORIZATION_URL", "That is the address of OpenAI's page"],
    ["an address cut short", "http://127.0.0.1:1455/auth/callback?code=abc", "cut short"],
    [
      "a made-up state",
      "http://127.0.0.1:1455/auth/callback?code=abc&state=made-up",
      "belongs to no sign-in you began here",
    ],
  ])("is refused, saying why, for %s", async (_case, pasted, explanation) => {
    const authorizationUrl = await beginSignIn(adaToken);
    const response = await finishSignIn(
      adaToken,
      pasted.replace("AUTHORIZATION_URL", authorizationUrl),
    );

    expect(response.status).toBe(400);
    expect(await readRefusal(response)).toEqual({
      code: "chatgpt_sign_in_failed",
      message: expect.stringContaining(explanation),
    });
  });

  it("works once: the same address again is refused as used", async () => {
    const finalAddress = signInServer.approve(await beginSignIn(adaToken), "chatgpt-ada");
    expect((await finishSignIn(adaToken, finalAddress)).status).toBe(200);

    const again = await finishSignIn(adaToken, finalAddress);

    expect(again.status).toBe(400);
    expect((await readRefusal(again)).message).toContain("was used already");
  });

  it("belonging to another user's sign-in is refused as one never begun, and connects nothing for either", async () => {
    const adasAddress = signInServer.approve(await beginSignIn(adaToken), "chatgpt-ada");

    const response = await finishSignIn(graceToken, adasAddress);

    expect((await readRefusal(response)).message).toContain("belongs to no sign-in you began here");
    expect((await readStatus(graceToken)).connection).toBeNull();
    expect((await finishSignIn(adaToken, adasAddress)).status).toBe(200);
  });

  it("says the user declined when they did", async () => {
    const declined = signInServer.deny(await beginSignIn(adaToken));

    const response = await finishSignIn(adaToken, declined);

    expect((await readRefusal(response)).message).toContain("You chose not to let Barrack");
  });

  it("connects nothing when the user did not allow plan usage", async () => {
    signInServer.nextGrantedScope = "openid profile email offline_access";
    const finalAddress = signInServer.approve(await beginSignIn(adaToken), "chatgpt-ada");

    const response = await finishSignIn(adaToken, finalAddress);

    expect((await readRefusal(response)).message).toContain(
      "did not allow Barrack to use your ChatGPT plan",
    );
    expect((await readStatus(adaToken)).connection).toBeNull();
    expect(signInServer.isSignInRevoked("chatgpt-ada")).toBe(true);
  });

  it("revokes the tokens OpenAI issued when its answer has no ID token to check", async () => {
    signInServer.nextTokenAnswerChanges = { id_token: undefined };
    const finalAddress = signInServer.approve(await beginSignIn(adaToken), "chatgpt-ada");

    const response = await finishSignIn(adaToken, finalAddress);

    expect(response.status).toBe(400);
    expect(signInServer.isSignInRevoked("chatgpt-ada")).toBe(true);
  });

  it("revokes the tokens OpenAI issued when its ID token's keys cannot be fetched", async () => {
    signInServer.isKeySetUnavailable = true;
    const finalAddress = signInServer.approve(await beginSignIn(adaToken), "chatgpt-ada");

    const response = await finishSignIn(adaToken, finalAddress);

    expect(response.ok).toBe(false);
    expect(signInServer.isSignInRevoked("chatgpt-ada")).toBe(true);
    expect((await readStatus(adaToken)).connection).toBeNull();
  });

  it("revokes the sign-in it replaces when the user connects again", async () => {
    await connect(adaToken, "chatgpt-ada");
    const first = await store.readSignIn(ada.userId);

    await connect(adaToken, "chatgpt-ada");

    const second = await store.readSignIn(ada.userId);
    expect(signInServer.revocations).toEqual([first?.tokens.refreshToken]);
    expect(signInServer.checkAccessToken(second?.tokens.accessToken ?? "").kind).toBe("valid");
  });

  it("forgets and revokes the sign-in made with a client OpenAI no longer accepts, saying why", async () => {
    await connect(adaToken, "chatgpt-ada");
    const kept = await store.readSignIn(ada.userId);
    const finalAddress = signInServer.approve(await beginSignIn(adaToken), "chatgpt-ada");
    signInServer.nextTokenRefusal = { status: 401, error: "invalid_client" };

    const response = await finishSignIn(adaToken, finalAddress);

    expect(response.status).toBe(400);
    const status = await readStatus(adaToken);
    expect(status.connection).toBeNull();
    expect(status.loss?.reason).toBe("sign_in_expired");
    expect(signInServer.revocations).toEqual([kept?.tokens.refreshToken]);
  });

  it("connects a plan whose token answer leaves the scopes out, granted as asked", async () => {
    signInServer.nextTokenAnswerChanges = { scope: undefined };
    const finalAddress = signInServer.approve(await beginSignIn(adaToken), "chatgpt-ada");

    const response = await finishSignIn(adaToken, finalAddress);

    expect(response.status).toBe(200);
    expect((await readStatus(adaToken)).connection).not.toBeNull();
  });

  it("reads the scopes from the callback when the token answer leaves them out", async () => {
    signInServer.nextTokenAnswerChanges = { scope: undefined };
    const approved = new URL(signInServer.approve(await beginSignIn(adaToken), "chatgpt-ada"));
    approved.searchParams.set("scope", "openid profile email offline_access");

    const response = await finishSignIn(adaToken, approved.href);

    expect((await readRefusal(response)).message).toContain(
      "did not allow Barrack to use your ChatGPT plan",
    );
    expect(signInServer.isSignInRevoked("chatgpt-ada")).toBe(true);
  });

  it.each([
    ["another nonce", { nonce: "not-the-nonce-sent" }],
    ["another audience", { aud: ["oaiapp-someone-else"] }],
    ["another issuer", { iss: "https://issuer.example" }],
    ["an expiry passed", { exp: 1_000_000_000 }],
  ])("connects nothing when the ID token has %s", async (_case, claims) => {
    signInServer.nextIdTokenClaims = claims;
    const finalAddress = signInServer.approve(await beginSignIn(adaToken), "chatgpt-ada");

    const response = await finishSignIn(adaToken, finalAddress);

    expect((await readRefusal(response)).message).toContain("could not be verified");
    expect((await readStatus(adaToken)).connection).toBeNull();
  });
});

describe("a connected plan", () => {
  it("lists the models the plan offers that the agent can run, in OpenAI's order", async () => {
    await connect(adaToken, "chatgpt-ada");

    const response = await controlPlane.getApi(chatGptPlanModelsApiPath, adaToken);

    expect(chatGptPlanModelListSchema.parse(await response.json()).models).toEqual([
      { modelId: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
      { modelId: "gpt-6.2-sol", name: "GPT-6.2 Sol" },
    ]);
  });

  it("can be set aside for the user's API key, and chosen again, but not chosen before it is connected", async () => {
    const tooEarly = await controlPlane.sendJson(
      "PUT",
      chatGptPlanOpenAiAccessApiPath,
      { access: "chatgpt_plan" },
      adaToken,
    );
    expect(tooEarly.status).toBe(409);
    await connect(adaToken, "chatgpt-ada");

    await controlPlane.sendJson(
      "PUT",
      chatGptPlanOpenAiAccessApiPath,
      { access: "api_key" },
      adaToken,
    );
    expect((await readStatus(adaToken)).openAiAccess).toBe("api_key");
    await controlPlane.sendJson(
      "PUT",
      chatGptPlanOpenAiAccessApiPath,
      { access: "chatgpt_plan" },
      adaToken,
    );
    expect((await readStatus(adaToken)).openAiAccess).toBe("chatgpt_plan");
  });

  it("is the connecting user's alone", async () => {
    await connect(adaToken, "chatgpt-ada");

    expect((await readStatus(graceToken)).connection).toBeNull();
    expect((await controlPlane.getApi(chatGptPlanModelsApiPath, graceToken)).status).toBe(409);
    expect(await controlPlane.chatGptPlan.findAccess(grace.userId, "openai")).toBe("api_key");
  });

  it("is disconnected by revoking it at OpenAI and forgetting it, the user's OpenAI models back on their key", async () => {
    await connect(adaToken, "chatgpt-ada");
    const signIn = await store.readSignIn(ada.userId);

    const response = await controlPlane.sendJson("DELETE", chatGptPlanApiPath, {}, adaToken);

    expect(chatGptPlanDisconnectionSchema.parse(await response.json())).toEqual({
      status: expect.objectContaining({ connection: null, openAiAccess: "api_key" }),
      revocation: "revoked",
    });
    expect(signInServer.revocations).toEqual([signIn?.tokens.refreshToken]);
    expect(signInServer.isSignInRevoked("chatgpt-ada")).toBe(true);
    expect(await store.readSignIn(ada.userId)).toBeUndefined();
    expect((await controlPlane.sendJson("DELETE", chatGptPlanApiPath, {}, adaToken)).status).toBe(
      404,
    );
  });

  it("is forgotten here even when OpenAI cannot confirm the revocation, which the answer says", async () => {
    await connect(adaToken, "chatgpt-ada");
    await signInServer.close();

    const response = await controlPlane.sendJson("DELETE", chatGptPlanApiPath, {}, adaToken);

    expect(chatGptPlanDisconnectionSchema.parse(await response.json()).revocation).toBe(
      "not_confirmed",
    );
    expect(await store.readSignIn(ada.userId)).toBeUndefined();
    signInServer = await FakeChatGptSignIn.start();
  });

  it("never appears in the log: no token, code, state or pasted address", async () => {
    const authorizationUrl = await beginSignIn(adaToken);
    const finalAddress = signInServer.approve(authorizationUrl, "chatgpt-ada");
    await finishSignIn(adaToken, finalAddress);
    const signIn = await store.readSignIn(ada.userId);
    await controlPlane.sendJson("DELETE", chatGptPlanApiPath, {}, adaToken);

    const secrets = [
      signIn?.tokens.accessToken,
      signIn?.tokens.refreshToken,
      new URL(finalAddress).searchParams.get("code"),
      new URL(finalAddress).searchParams.get("state"),
      new URL(authorizationUrl).searchParams.get("nonce"),
    ];
    const log = controlPlane.logLines.join("\n");
    expect(secrets.every((secret) => typeof secret === "string" && secret.length > 10)).toBe(true);
    expect(secrets.filter((secret) => log.includes(String(secret)))).toEqual([]);
  });
});

describe("an installation that does not offer ChatGPT plans", () => {
  it("says so, and begins no sign-in", async () => {
    await controlPlane.close();
    controlPlane = await TestControlPlane.start({
      authentication: { kind: "test-issuer", issuer: identityIssuer },
    });

    expect(await readStatus(adaToken)).toMatchObject({ availability: "turned_off" });
    const response = await controlPlane.sendJson(
      "POST",
      chatGptPlanSignInApiPath,
      { allowsBackgroundUse: true },
      adaToken,
    );
    expect((await readRefusal(response)).code).toBe("chatgpt_plan_unavailable");
  });
});

describe("an installation that turned ChatGPT plans off after a plan was connected", () => {
  async function turnPlansOff(): Promise<void> {
    await controlPlane.close();
    controlPlane = await TestControlPlane.start({
      authentication: { kind: "test-issuer", issuer: identityIssuer },
      chatGptPlan: { signInIssuer: signInServer.issuer, isOffered: false },
      chatGptPlanStore: store,
      modelProxyUpstreamOrigin: modelServer.origin,
    });
  }

  it("still revokes and forgets the sign-in it kept, when the user disconnects", async () => {
    await connect(adaToken, "chatgpt-ada");
    const signIn = await store.readSignIn(ada.userId);
    await turnPlansOff();

    expect(await readStatus(adaToken)).toMatchObject({
      availability: "turned_off",
      connection: { accountEmail: "ada@chatgpt.example" },
    });
    const response = await controlPlane.sendJson("DELETE", chatGptPlanApiPath, {}, adaToken);

    expect(chatGptPlanDisconnectionSchema.parse(await response.json()).revocation).toBe("revoked");
    expect(signInServer.revocations).toEqual([signIn?.tokens.refreshToken]);
    expect(await store.readSignIn(ada.userId)).toBeUndefined();
  });

  it("keeps the user's OpenAI models off their API key until they choose it", async () => {
    await connect(adaToken, "chatgpt-ada");
    await controlPlane.saveModelCredential("openai", "fake-openai-key-of-ada-0001", adaToken);
    await turnPlansOff();

    const refused = await controlPlane.sendJson(
      "POST",
      "/api/threads",
      { model: "openai/gpt-6.1-sol" },
      adaToken,
    );
    expect(refused.status).toBe(409);
    expect((await readRefusal(refused)).message).toContain("no longer offers");
    expect(await controlPlane.chatGptPlan.findAccess(ada.userId, "openai")).toBe("chatgpt_plan");

    const chosen = await controlPlane.sendJson(
      "PUT",
      chatGptPlanOpenAiAccessApiPath,
      { access: "api_key" },
      adaToken,
    );
    expect(chosen.status).toBe(200);
    expect(await controlPlane.chatGptPlan.findAccess(ada.userId, "openai")).toBe("api_key");
  });
});

describe("disconnecting when OpenAI's sign-in cannot be reached", () => {
  it("forgets the sign-in and says the revocation is not confirmed, rather than failing", async () => {
    await connect(adaToken, "chatgpt-ada");
    const unreachable = new ChatGptPlanAccess({
      settings: { isOffered: true, issuer: "http://127.0.0.1:9" },
      store,
      client: new ChatGptSignInClient("http://127.0.0.1:9"),
      logger: pino({ level: "silent" }),
      sleep: async () => undefined,
    });

    expect(await unreachable.disconnect(ada.userId)).toEqual({ revocation: "not_confirmed" });
    expect(await store.readSignIn(ada.userId)).toBeUndefined();
  });
});

describe("signing in when something other than the sign-in fails", () => {
  async function restartWith(options: {
    threadStore?: InMemoryThreadStore;
    chatGptPlanStore?: InMemoryChatGptPlanStore;
  }): Promise<void> {
    await controlPlane.close();
    controlPlane = await TestControlPlane.start({
      authentication: { kind: "test-issuer", issuer: identityIssuer },
      chatGptPlan: { signInIssuer: signInServer.issuer },
      chatGptPlanStore: options.chatGptPlanStore ?? store,
      ...(options.threadStore === undefined ? {} : { threadStore: options.threadStore }),
      modelProxyUpstreamOrigin: modelServer.origin,
    });
  }

  it("says OpenAI could not be reached only when it could not", async () => {
    await signInServer.close();

    const response = await controlPlane.sendJson(
      "POST",
      chatGptPlanSignInApiPath,
      { allowsBackgroundUse: true },
      adaToken,
    );

    expect(response.status).toBe(503);
    expect((await readRefusal(response)).message).toContain(
      "OpenAI's sign-in could not be reached",
    );
    signInServer = await FakeChatGptSignIn.start();
  });

  it("says the control plane could not begin, when its own store fails", async () => {
    const failingStore = new InMemoryChatGptPlanStore(new CredentialKeyring(Buffer.alloc(32, 7)));
    failingStore.saveAttempt = () => Promise.reject(new Error("The database is unreachable."));
    await restartWith({ chatGptPlanStore: failingStore });

    const response = await controlPlane.sendJson(
      "POST",
      chatGptPlanSignInApiPath,
      { allowsBackgroundUse: true },
      adaToken,
    );

    expect(response.status).toBe(503);
    expect((await readRefusal(response)).message).toContain(
      "The control plane could not begin your sign-in",
    );
  });

  it("answers a connected plan as connected even when its threads cannot be told at once", async () => {
    const threadStore = new InMemoryThreadStore();
    const listThreads = threadStore.listMostRecentlyActiveOwnedBy.bind(threadStore);
    let listings = 0;
    // The first listing, before the sign-in, notes the user's open runs; the next, after it, fails.
    threadStore.listMostRecentlyActiveOwnedBy = (ownerUserId, limit) => {
      listings += 1;
      return listings === 1
        ? listThreads(ownerUserId, limit)
        : Promise.reject(new Error("The database is unreachable."));
    };
    await restartWith({ threadStore });
    const finalAddress = signInServer.approve(await beginSignIn(adaToken), "chatgpt-ada");

    const response = await finishSignIn(adaToken, finalAddress);

    expect(response.status).toBe(200);
    expect(chatGptPlanStatusSchema.parse(await response.json()).connection).not.toBeNull();
  });

  it("shows OpenAI's own description of an error that ended the sign-in", async () => {
    const ended = new URL(signInServer.deny(await beginSignIn(adaToken)));
    ended.searchParams.set("error", "server_error");
    ended.searchParams.set("error_description", "The sign-in service is under maintenance.");

    const response = await finishSignIn(adaToken, ended.href);

    expect((await readRefusal(response)).message).toContain(
      '"server_error": The sign-in service is under maintenance.',
    );
  });
});
