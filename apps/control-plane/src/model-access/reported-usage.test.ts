import { randomBytes } from "node:crypto";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { InMemoryModelProxyTokenStore } from "../model-proxy/in-memory-model-proxy-token-store.js";
import { ModelProxyTokens } from "../model-proxy/model-proxy-tokens.js";
import { InMemoryModelUsageStore } from "../model-usage/in-memory-model-usage-store.js";
import { ModelUsage } from "../model-usage/model-usage.js";
import { recordTestThread } from "../test-support/record-test-thread.js";
import { createUnofferedChatGptPlan } from "../test-support/unoffered-chatgpt-plan.js";
import { InMemoryThreadStore } from "../threads/in-memory-thread-store.js";
import { CredentialKeyring } from "./credential-keyring.js";
import { InMemoryModelCredentialStore } from "./in-memory-model-credential-store.js";
import { ModelCredentials } from "./model-credentials.js";
import {
  OwnerModelAccess,
  unrecognisedModelId,
  unrecognisedProviderId,
} from "./owner-model-access.js";

/** What a sandbox reports its agent used, for a provider whose key is placed in the sandbox. */

const owner = "user-a";
const logger = pino({ level: "silent" });

async function startThreadOn(model: string) {
  const threadStore = new InMemoryThreadStore();
  await recordTestThread(threadStore, { threadId: "thread-a", ownerUserId: owner });
  await threadStore.changeModel(owner, "thread-a", model);
  const usage = new ModelUsage({
    store: new InMemoryModelUsageStore(),
    settings: { installationCapTokens: undefined, windowHours: 24 },
    logger,
  });
  const keyring = new CredentialKeyring(randomBytes(32));
  const chatGptPlan = createUnofferedChatGptPlan(keyring);
  const access = new OwnerModelAccess({
    threadStore,
    credentials: new ModelCredentials({
      store: new InMemoryModelCredentialStore(keyring),
      chatGptPlan,
      logger,
    }),
    chatGptPlan,
    isModelRequired: true,
    proxyTokens: new ModelProxyTokens(new InMemoryModelProxyTokenStore()),
    usage,
    controlPlaneUrlForSandboxes: "http://control-plane.test",
  });
  const report = (model: string, inputTokens = 10) =>
    access.noteReportedUsage("thread-a", {
      model,
      inputTokens,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  return { usage, report };
}

describe("usage a sandbox reports", () => {
  it("keeps models the catalogue lists, and the thread's own, and folds the rest into one row per provider", async () => {
    const { usage, report } = await startThreadOn("mistral/a-model-of-my-own");

    await report("mistral/codestral-latest");
    await report("mistral/a-model-of-my-own");
    await report("mistral/made-up-1");
    await report("mistral/made-up-2");
    await report("made-up-provider/anything");
    await report("anthropic/relayed-so-measured-instead");

    const rows = await usage.listForThread(owner, "thread-a");
    expect(rows.map((row) => [row.providerId, row.modelId, row.answerCount]).sort()).toEqual(
      [
        ["mistral", "codestral-latest", 1],
        ["mistral", "a-model-of-my-own", 1],
        ["mistral", unrecognisedModelId, 2],
        [unrecognisedProviderId, unrecognisedModelId, 1],
      ].sort(),
    );
    expect(rows.every((row) => row.source === "reported")).toBe(true);
  });
});
