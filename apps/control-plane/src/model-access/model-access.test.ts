import {
  apiErrorResponseSchema,
  buildModelCredentialApiPath,
  buildThreadModelApiPath,
  type ConfigureModelAccess,
  type ControlPlaneToSupervisorMessage,
  modelCatalogueApiPath,
  modelCatalogueSchema,
  modelCredentialListResponseSchema,
  modelCredentialsApiPath,
  threadResponseSchema,
} from "@barrack/protocol";
import { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  browserHeaders,
  TestControlPlane,
  type TestControlPlaneOptions,
  type TestThread,
} from "../test-support/test-control-plane.js";
import type { FakeSupervisor } from "../test-support/test-peers.js";

/**
 * Each user's own model access, through the real control plane: keys added
 * in settings, a model per thread, and each thread's supervisor told its
 * model and its owner's key for it, and nothing else. Two users sign in
 * with tokens from a test identity issuer, verified as Supabase's would be.
 */

const ada = { userId: "11111111-1111-4111-8111-111111111111", email: "ada@example.com" };
const grace = { userId: "22222222-2222-4222-8222-222222222222", email: "grace@example.com" };

const adasAnthropicKey = "sk-ant-ada-0000000000000001";
const adasOpenAiKey = "sk-openai-ada-00000000000002";
const gracesAnthropicKey = "sk-ant-grace-000000000000003";
const adasReplacementKey = "sk-ant-ada-replacement-0004";
const everySecret = [adasAnthropicKey, adasOpenAiKey, gracesAnthropicKey, adasReplacementKey];

let issuer: TestIdentityIssuer;
let controlPlane: TestControlPlane;
let adaToken: string;
let graceToken: string;
/** Every response body the test read, to search for keys. */
let responseBodies: string[];

beforeEach(async () => {
  issuer = await TestIdentityIssuer.start();
  adaToken = await issuer.mintAccessToken(ada);
  graceToken = await issuer.mintAccessToken(grace);
  responseBodies = [];
});

afterEach(async () => {
  await controlPlane?.close();
  await issuer.close();
});

async function start(options: Omit<TestControlPlaneOptions, "authentication"> = {}) {
  controlPlane = await TestControlPlane.start({
    authentication: { kind: "test-issuer", issuer },
    ...options,
  });
}

/** Status and parsed body, keeping the body to search for keys afterwards. */
async function read(response: Response): Promise<{ status: number; body: unknown }> {
  const text = await response.text();
  responseBodies.push(text);
  return { status: response.status, body: JSON.parse(text) };
}

async function saveKey(providerId: string, secret: string, token: string, settings = {}) {
  return read(await controlPlane.saveModelCredential(providerId, secret, token, settings));
}

async function listKeys(token: string) {
  const { body } = await read(await controlPlane.getApi(modelCredentialsApiPath, token));
  return modelCredentialListResponseSchema.parse(body).credentials;
}

function modelAccessMessages(supervisor: FakeSupervisor): ConfigureModelAccess[] {
  return supervisor.inbox.messages.filter(
    (message: ControlPlaneToSupervisorMessage): message is ConfigureModelAccess =>
      message.type === "configure_model_access",
  );
}

async function waitForModelAccess(
  supervisor: FakeSupervisor,
  description: string,
  matches: (message: ConfigureModelAccess) => boolean,
): Promise<void> {
  await supervisor.inbox.waitFor(
    description,
    (message) => message.type === "configure_model_access" && matches(message),
  );
}

async function createThreadOn(model: string, token: string): Promise<TestThread> {
  return controlPlane.createThread(token, model);
}

function expectNoKeyAnywhere(): void {
  for (const text of [...responseBodies, ...controlPlane.logLines]) {
    for (const secret of everySecret) {
      expect(text).not.toContain(secret);
    }
  }
}

describe("a user's model keys", () => {
  it("are added, listed by provider and last four characters alone, replaced and removed, and never answered or logged", async () => {
    await start();

    const saved = await saveKey("anthropic", adasAnthropicKey, adaToken);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      credential: { providerId: "anthropic", addedAt: expect.any(String), secretEnding: "0001" },
    });
    expect(await listKeys(adaToken)).toEqual([
      { providerId: "anthropic", addedAt: expect.any(String), secretEnding: "0001" },
    ]);

    await saveKey("anthropic", adasOpenAiKey, adaToken);
    expect((await listKeys(adaToken)).map((key) => key.secretEnding)).toEqual(["0002"]);

    const removed = await read(
      await controlPlane.sendJson("DELETE", buildModelCredentialApiPath("anthropic"), {}, adaToken),
    );
    expect(removed).toEqual({ status: 200, body: { credentials: [] } });
    const removedAgain = await controlPlane.sendJson(
      "DELETE",
      buildModelCredentialApiPath("anthropic"),
      {},
      adaToken,
    );
    expect(removedAgain.status).toBe(404);
    expectNoKeyAnywhere();
  });

  it("are refused when they cannot be keys, or lack or add settings their provider does not take", async () => {
    await start();

    const withSpace = await saveKey("anthropic", "sk-ant has a space", adaToken);
    const withoutAccount = await saveKey("cloudflare-workers-ai", "cf-key-0123456789", adaToken);
    const withStrangeSetting = await saveKey("anthropic", adasAnthropicKey, adaToken, {
      ANTHROPIC_BASE_URL: "https://elsewhere.example",
    });
    const withAccount = await saveKey("cloudflare-workers-ai", "cf-key-0123456789", adaToken, {
      CLOUDFLARE_ACCOUNT_ID: "account-1",
    });

    expect(withSpace.status).toBe(400);
    expect(apiErrorResponseSchema.parse(withSpace.body).error.message).toMatch(/cannot be a key/);
    expect(withoutAccount.status).toBe(400);
    expect(apiErrorResponseSchema.parse(withoutAccount.body).error.message).toContain(
      "Cloudflare account ID",
    );
    expect(withStrangeSetting.status).toBe(400);
    expect(withAccount.status).toBe(200);
    expectNoKeyAnywhere();
  });

  it("are one user's alone: another user sees none of them, cannot remove them, and cannot run on them", async () => {
    await start();
    await saveKey("anthropic", adasAnthropicKey, adaToken);
    await saveKey("openai", adasOpenAiKey, adaToken);
    await saveKey("anthropic", gracesAnthropicKey, graceToken);

    expect((await listKeys(graceToken)).map((key) => key.providerId)).toEqual(["anthropic"]);
    const removingAdas = await controlPlane.sendJson(
      "DELETE",
      buildModelCredentialApiPath("openai"),
      {},
      graceToken,
    );
    expect(removingAdas.status).toBe(404);
    const graceOnOpenAi = await read(
      await controlPlane.postThread(
        browserHeaders(graceToken),
        JSON.stringify({ model: "openai/example-model" }),
      ),
    );
    expect(graceOnOpenAi.status).toBe(409);
    expect((await listKeys(adaToken)).map((key) => key.providerId)).toEqual([
      "anthropic",
      "openai",
    ]);
    expectNoKeyAnywhere();
  });
});

describe("each thread's model access", () => {
  it("hands each thread's supervisor its owner's key for its own model's provider, and no other", async () => {
    await start();
    await saveKey("anthropic", adasAnthropicKey, adaToken);
    await saveKey("openai", adasOpenAiKey, adaToken);
    await saveKey("anthropic", gracesAnthropicKey, graceToken);
    const adasThread = await createThreadOn("anthropic/example-model", adaToken);
    const gracesThread = await createThreadOn("anthropic/example-model", graceToken);

    const adasSupervisor = await controlPlane.connectSupervisor(adasThread);
    const gracesSupervisor = await controlPlane.connectSupervisor(gracesThread);
    await waitForModelAccess(adasSupervisor, "Ada's model access", () => true);
    await waitForModelAccess(gracesSupervisor, "Grace's model access", () => true);

    expect(modelAccessMessages(adasSupervisor)).toEqual([
      {
        type: "configure_model_access",
        model: "anthropic/example-model",
        credential: { kind: "api_key", secret: adasAnthropicKey, settings: {} },
      },
    ]);
    expect(modelAccessMessages(gracesSupervisor)).toEqual([
      {
        type: "configure_model_access",
        model: "anthropic/example-model",
        credential: { kind: "api_key", secret: gracesAnthropicKey, settings: {} },
      },
    ]);
    expect(JSON.stringify(gracesSupervisor.inbox.messages)).not.toContain("ada");
    expectNoKeyAnywhere();
  });

  it("refuses a thread for a model whose provider the user has no key for, saying which key to add and where", async () => {
    await start({ isModelRequired: true });

    const withoutKey = await read(
      await controlPlane.postThread(
        browserHeaders(adaToken),
        JSON.stringify({ model: "openai/example-model" }),
      ),
    );
    const withoutModel = await read(await controlPlane.postThread(browserHeaders(adaToken), "{}"));

    expect(withoutKey).toEqual({
      status: 409,
      body: {
        error: {
          code: "model_credential_missing",
          message:
            "openai/example-model runs on OpenAI, and you have no OpenAI API key. Add it in Settings, under Model access, then create the thread again.",
        },
      },
    });
    expect(withoutModel.status).toBe(400);
  });

  it("switches a thread to another model, tells its supervisor at once, and refuses a model without a key", async () => {
    await start();
    await saveKey("anthropic", adasAnthropicKey, adaToken);
    await saveKey("openai", adasOpenAiKey, adaToken);
    const thread = await createThreadOn("anthropic/example-model", adaToken);
    const supervisor = await controlPlane.connectSupervisor(thread);
    await waitForModelAccess(supervisor, "the first model access", () => true);

    const switched = await read(
      await controlPlane.sendJson(
        "PUT",
        buildThreadModelApiPath(thread.threadId),
        { model: "openai/other-model" },
        adaToken,
      ),
    );
    await waitForModelAccess(supervisor, "the new model", (message) => {
      return message.model === "openai/other-model";
    });
    const withoutKey = await controlPlane.sendJson(
      "PUT",
      buildThreadModelApiPath(thread.threadId),
      { model: "mistral/example-model" },
      adaToken,
    );
    const byAnotherUser = await controlPlane.sendJson(
      "PUT",
      buildThreadModelApiPath(thread.threadId),
      { model: "anthropic/example-model" },
      graceToken,
    );

    expect(switched.status).toBe(200);
    expect(threadResponseSchema.parse(switched.body).thread.model).toBe("openai/other-model");
    expect(modelAccessMessages(supervisor).at(-1)).toEqual({
      type: "configure_model_access",
      model: "openai/other-model",
      credential: { kind: "api_key", secret: adasOpenAiKey, settings: {} },
    });
    expect(withoutKey.status).toBe(409);
    expect(byAnotherUser.status).toBe(404);
    expectNoKeyAnywhere();
  });

  it("sends a replaced key at once, withdraws a removed one, and refuses messages until a key is back", async () => {
    await start();
    await saveKey("anthropic", adasAnthropicKey, adaToken);
    const thread = await createThreadOn("anthropic/example-model", adaToken);
    const supervisor = await controlPlane.connectSupervisor(thread);
    const client = await controlPlane.connectClient(thread.threadId, 0, adaToken);
    await waitForModelAccess(supervisor, "the first key", () => true);

    await saveKey("anthropic", adasReplacementKey, adaToken);
    await waitForModelAccess(supervisor, "the replacement", (message) => {
      return message.credential?.secret === adasReplacementKey;
    });
    await controlPlane.sendJson("DELETE", buildModelCredentialApiPath("anthropic"), {}, adaToken);
    await waitForModelAccess(
      supervisor,
      "the withdrawal",
      (message) => message.credential === null,
    );

    const refusedId = client.sendUserMessage("Are you there?");
    const refusal = await client.inbox.waitFor(
      "the refusal",
      (message) => message.type === "client_message_rejected",
    );
    await saveKey("anthropic", adasAnthropicKey, adaToken);
    await waitForModelAccess(supervisor, "the key again", (message) => {
      return (
        message.credential?.secret === adasAnthropicKey &&
        modelAccessMessages(supervisor).length === 4
      );
    });
    client.sendUserMessage("Are you there?", refusedId);
    const delivery = await supervisor.inbox.waitFor(
      "the message",
      (message) => message.type === "deliver_user_message",
    );

    expect(refusal).toEqual({
      type: "client_message_rejected",
      messageId: refusedId,
      reason:
        "anthropic/example-model runs on Anthropic, and you have no Anthropic API key. Add it in Settings, under Model access, then send your message again.",
    });
    expect(delivery).toMatchObject({ text: "Are you there?" });
    expect(client.threadEvents.map((recorded) => recorded.event.type)).toEqual(["user_message"]);
    expectNoKeyAnywhere();
    expect(JSON.stringify(client.inbox.messages)).not.toContain(adasAnthropicKey);
  });
});

describe("the model catalogue", () => {
  it("lists what the pinned agent supports, the common providers first, to a signed-in user", async () => {
    await start();

    const { status, body } = await read(await controlPlane.getApi(modelCatalogueApiPath, adaToken));

    expect(status).toBe(200);
    const catalogue = modelCatalogueSchema.parse(body);
    expect(catalogue.agent.name).toBe("Pi");
    expect(catalogue.providers[0]?.providerId).toBe("anthropic");
  });
});
