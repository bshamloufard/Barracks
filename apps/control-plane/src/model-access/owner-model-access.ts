import { findCatalogueProvider, isRelayedProvider } from "@barrack/model-catalogue";
import {
  buildModelProxyBasePath,
  type ConfigureModelAccess,
  type ModelCredential,
  parseModelReference,
  type ReportedModelUsage,
} from "@barrack/protocol";
import type { ChatGptPlanAccess } from "../chatgpt-plan/chatgpt-plan-access.js";
import type { ModelProxyTokens } from "../model-proxy/model-proxy-tokens.js";
import { describeReachedCap, type ModelUsage } from "../model-usage/model-usage.js";
import type {
  ModelAccessConnection,
  ThreadModelAccess,
} from "../thread-relay/thread-model-access.js";
import type { ThreadStore } from "../threads/thread-store.js";
import type { ModelCredentials } from "./model-credentials.js";

/**
 * Where usage a sandbox reports for a model it could not have been given is
 * counted, so made-up names add one row per provider and hour at most.
 * Neither can be a real provider or model identifier.
 */
export const unrecognisedProviderId = "unrecognised";
export const unrecognisedModelId = "(unrecognised model)";

export type OwnerModelAccessOptions = {
  threadStore: ThreadStore;
  credentials: ModelCredentials;
  /** Whether the owner's OpenAI models run on their ChatGPT plan, and whether it is connected. */
  chatGptPlan: ChatGptPlanAccess;
  /** The agent cannot run without a model (Pi); the fake agent can. */
  isModelRequired: boolean;
  proxyTokens: ModelProxyTokens;
  usage: ModelUsage;
  /** Where sandboxes reach the control plane over HTTP, such as `https://barrack.example.com`. */
  controlPlaneUrlForSandboxes: string;
};

/**
 * Each thread's model access, decided from the thread's own record: its
 * model, and its owner's credential for that model's provider. A sandbox
 * therefore only ever receives what reaches its own thread's owner's key,
 * and only for its own thread's model, whatever its supervisor sends.
 *
 * For a provider whose traffic the control plane relays, that is not the
 * key but a token for the model proxy, minted once per supervisor
 * connection and provider, with the proxy's address for this thread and
 * provider, and what the proxy spends: the owner's key, or for OpenAI their
 * ChatGPT plan if they chose it; the key, and the plan's tokens, stay here.
 * For any other provider, it is the key.
 *
 * When the credential is sealed under a key this control plane does not
 * hold, `describe` throws rather than describe no credential: the relay
 * then leaves an attached supervisor with the key it has, and turns away
 * one attaching, which reconnects, normally to the instance that holds
 * the key.
 */
export class OwnerModelAccess implements ThreadModelAccess {
  readonly #options: OwnerModelAccessOptions;

  constructor(options: OwnerModelAccessOptions) {
    this.#options = options;
  }

  async describe(
    threadId: string,
    connection: ModelAccessConnection,
  ): Promise<ConfigureModelAccess> {
    const thread = await this.#options.threadStore.find(threadId);
    const model = thread?.model;
    const ownerUserId = thread?.ownerUserId;
    if (model === undefined || ownerUserId === undefined) {
      return { type: "configure_model_access", model: model ?? null, credential: null };
    }
    const { providerId } = parseModelReference(model);
    const credential = isRelayedProvider(providerId)
      ? await this.#describeRelayedCredential(threadId, ownerUserId, providerId, connection)
      : await this.#describeKey(ownerUserId, providerId);
    return { type: "configure_model_access", model, credential };
  }

  async admitUserMessage(
    threadId: string,
  ): Promise<{ isAccepted: true } | { isAccepted: false; reason: string }> {
    const { threadStore, credentials, usage, isModelRequired } = this.#options;
    const thread = await threadStore.find(threadId);
    if (thread === undefined || thread.ownerUserId === undefined) {
      return { isAccepted: true };
    }
    if (thread.model === undefined) {
      return isModelRequired
        ? {
            isAccepted: false,
            reason:
              "This thread has no model yet. Choose one for it, then send your message again.",
          }
        : { isAccepted: true };
    }
    const missing = await credentials.describeMissingCredential(
      thread.ownerUserId,
      thread.model,
      "send your message again",
    );
    if (missing !== undefined) {
      return { isAccepted: false, reason: missing };
    }
    if (!isRelayedProvider(parseModelReference(thread.model).providerId)) {
      return { isAccepted: true };
    }
    const cap = await usage.checkCap(thread.ownerUserId);
    return cap.isReached
      ? { isAccepted: false, reason: describeReachedCap(cap) }
      : { isAccepted: true };
  }

  /**
   * What a relayed provider's traffic used is measured at the proxy, so the
   * sandbox's own account of it is not counted twice. The sandbox is
   * untrusted, and each model it names would be a row of its own, so only a
   * model the catalogue lists for its provider, or the thread's own model,
   * is kept by name; any other is counted as the provider's unrecognised
   * model, and a provider the catalogue does not list as an unrecognised
   * provider. The counts themselves are bounded by the protocol.
   */
  async noteReportedUsage(threadId: string, reported: ReportedModelUsage): Promise<void> {
    if (isRelayedProvider(parseModelReference(reported.model).providerId)) {
      return;
    }
    const thread = await this.#options.threadStore.find(threadId);
    if (thread?.ownerUserId === undefined) {
      return;
    }
    const { providerId, modelId } = recognisedModelOf(reported.model, thread.model);
    await this.#options.usage.record({
      ownerUserId: thread.ownerUserId,
      threadId,
      providerId,
      modelId,
      source: "reported",
      inputTokens: reported.inputTokens,
      outputTokens: reported.outputTokens,
      cacheReadTokens: reported.cacheReadTokens,
      cacheWriteTokens: reported.cacheWriteTokens,
    });
  }

  async #describeKey(ownerUserId: string, providerId: string): Promise<ModelCredential | null> {
    const key = await this.#options.credentials.read(ownerUserId, providerId);
    return key === undefined ? null : { kind: "api_key", ...key };
  }

  /** The key itself is not opened, nor the plan's tokens read: the sandbox never receives them. */
  async #describeRelayedCredential(
    threadId: string,
    ownerUserId: string,
    providerId: string,
    connection: ModelAccessConnection,
  ): Promise<ModelCredential | null> {
    const { chatGptPlan, credentials } = this.#options;
    const access = await chatGptPlan.findAccess(ownerUserId, providerId);
    const isUsable =
      access === "chatgpt_plan"
        ? await chatGptPlan.isConnected(ownerUserId)
        : await credentials.has(ownerUserId, providerId);
    if (!isUsable) {
      return null;
    }
    // A switch retires other providers' tokens, so one handed out before
    // may no longer be accepted if the thread has switched back since.
    let token = connection.proxyTokens.get(providerId);
    if (
      token === undefined ||
      !(await this.#options.proxyTokens.isAccepted(threadId, providerId, token))
    ) {
      token = await this.#options.proxyTokens.mint(threadId, providerId);
      connection.proxyTokens.set(providerId, token);
    }
    return {
      kind: "proxy_token",
      secret: token,
      baseUrl: `${this.#options.controlPlaneUrlForSandboxes}${buildModelProxyBasePath(threadId, providerId)}`,
      access,
    };
  }
}

/** The reported model as it is counted: by name only if it could be the thread's. */
function recognisedModelOf(
  reportedModel: string,
  threadModel: string | undefined,
): { providerId: string; modelId: string } {
  const reference = parseModelReference(reportedModel);
  if (reportedModel === threadModel) {
    return reference;
  }
  const provider = findCatalogueProvider(reference.providerId);
  if (provider === undefined) {
    return { providerId: unrecognisedProviderId, modelId: unrecognisedModelId };
  }
  const isListed = provider.models.some((model) => model.modelId === reference.modelId);
  return isListed ? reference : { providerId: reference.providerId, modelId: unrecognisedModelId };
}
