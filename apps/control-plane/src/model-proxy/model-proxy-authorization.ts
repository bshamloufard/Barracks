import { findCatalogueProvider } from "@barrack/model-catalogue";
import { parseModelReference } from "@barrack/protocol";
import type { OwnerAdmission } from "../authentication/owner-admission.js";
import { UnreadableCredentialError } from "../model-access/credential-keyring.js";
import type { ModelCredentials } from "../model-access/model-credentials.js";
import { describeReachedCap, type ModelUsage } from "../model-usage/model-usage.js";
import type { ThreadStore } from "../threads/thread-store.js";
import type { ModelProxyTokens } from "./model-proxy-tokens.js";
import type { ModelSwitchAllowances } from "./model-switch-allowances.js";
import {
  credentialMissingRefusal,
  modelRefusal,
  type ProxyRefusal,
  proxyRefusals,
  usageCapRefusal,
} from "./proxy-refusals.js";

export type ProxyAuthorizationRequest = {
  threadId: string;
  providerId: string;
};

/** The models a request's body names, as the proxy read it. */
export type RequestedModels = {
  model: string;
  /** Others the provider may answer with if that one cannot (Anthropic's `fallbacks`). */
  fallbackModels: readonly string[];
};

export type ModelProxyAuthorizationOptions = {
  threadStore: ThreadStore;
  modelSwitchAllowances: ModelSwitchAllowances;
  tokens: ModelProxyTokens;
  credentials: ModelCredentials;
  ownerAdmission: OwnerAdmission;
  usage: ModelUsage;
};

/** Allowed: whose key to use, and the key itself, for this one request. */
export type ProxyAuthorization =
  | { kind: "allowed"; ownerUserId: string; ownerKey: string }
  | { kind: "refused"; refusal: ProxyRefusal; reason: string };

/**
 * Decides, for each request, whether the model proxy may spend a user's key
 * on it, from the records alone, read afresh every time so a change takes
 * effect on the next request. First, alone, whether the caller presents a
 * token minted for this very thread and provider (`authenticate`, see
 * `ModelProxyTokens`), before anything else is spent on the request; then
 * (`decide`) the thread's sandbox recorded running; the model the request
 * names the thread's own, or the one before a switch made while the run
 * still open began (see `ModelSwitchAllowances`); its owner still admitted;
 * the owner's own key for that provider; and the owner's usage cap not
 * reached.
 *
 * The owner and the key come from the thread named in the request path,
 * which is the thread the token was minted for, so a token can only ever
 * spend its own thread's owner's key: there is no way to name a user.
 */
export class ModelProxyAuthorization {
  readonly #options: ModelProxyAuthorizationOptions;

  constructor(options: ModelProxyAuthorizationOptions) {
    this.#options = options;
  }

  /**
   * Whether the token was minted for this thread and provider. The same
   * answer, and the same refusal, whether the thread does not exist or the
   * token is wrong. Throws when the store cannot be asked.
   */
  authenticate(request: ProxyAuthorizationRequest, presentedToken: string): Promise<boolean> {
    return this.#options.tokens.isAccepted(request.threadId, request.providerId, presentedToken);
  }

  /**
   * Whether an authenticated request may spend its owner's key. Throws when
   * it cannot decide (the database is unreachable, say), which is not a refusal.
   */
  async decide(
    request: ProxyAuthorizationRequest,
    requested: RequestedModels,
  ): Promise<ProxyAuthorization> {
    const { threadId, providerId } = request;
    const { threadStore } = this.#options;
    const thread = await threadStore.find(threadId);
    const ownerUserId = thread?.ownerUserId;
    if (thread === undefined || ownerUserId === undefined) {
      return refused(proxyRefusals.tokenRefused, "the thread is gone");
    }
    if (thread.sandbox.state !== "running") {
      return refused(proxyRefusals.tokenRefused, `its sandbox is ${thread.sandbox.state}`);
    }
    const modelRefused = await this.#checkModel(request, thread.model, requested);
    if (modelRefused !== undefined) {
      return modelRefused;
    }
    if (!(await this.#options.ownerAdmission.isStillAdmitted(ownerUserId))) {
      return refused(proxyRefusals.ownerNotAdmitted, "the owner is not admitted");
    }
    const ownerKey = await this.#readOwnerKey(ownerUserId, providerId);
    if (ownerKey === undefined) {
      return refused(credentialMissingRefusal(providerId), "the owner has no key for it");
    }
    const cap = await this.#options.usage.checkCap(ownerUserId);
    if (cap.isReached) {
      return refused(usageCapRefusal(describeReachedCap(cap)), "the owner's usage cap is reached");
    }
    return { kind: "allowed", ownerUserId, ownerKey };
  }

  /**
   * The agent asks only for the thread's model (the pinned agent's
   * compaction and summaries use the model it runs on too), so a request
   * for any other is refused: otherwise a sandbox could spend its owner's
   * key on the dearest model the key allows. The one exception is the
   * model before a switch, for the run still open on it. Anthropic's
   * `fallbacks`, which the agent sends for some models, may name only
   * models its catalogue lists for the provider. A provider in use by
   * neither has its tokens retired.
   */
  async #checkModel(
    request: ProxyAuthorizationRequest,
    threadModel: string | undefined,
    requested: RequestedModels,
  ): Promise<ProxyAuthorization | undefined> {
    const { threadId, providerId } = request;
    const current = modelIdFor(threadModel, providerId);
    const previousModel =
      current === requested.model
        ? undefined
        : await this.#options.modelSwitchAllowances.findPreviousModel(threadId);
    const previous = modelIdFor(previousModel, providerId);
    if (current === undefined && previous === undefined) {
      const providersInUse = [threadModel, previousModel].flatMap((model) =>
        model === undefined ? [] : [parseModelReference(model).providerId],
      );
      await this.#options.tokens.retainProviders(threadId, providersInUse);
      return refused(proxyRefusals.tokenRefused, "the thread runs on another provider now");
    }
    const isOwnModel = requested.model === current || requested.model === previous;
    const listedModelIds = new Set(
      findCatalogueProvider(providerId)?.models.map((model) => model.modelId),
    );
    const areFallbacksListed = requested.fallbackModels.every((fallback) =>
      listedModelIds.has(fallback),
    );
    if (!isOwnModel || !areFallbacksListed) {
      return refused(modelRefusal(threadModel ?? "none"), "the request names another model");
    }
    return undefined;
  }

  /**
   * A key sealed under a key this instance does not hold (another instance
   * rotated it, during a redeploy's overlap) is a reason to try again, not
   * a missing key: the agent retries, and normally reaches the other.
   */
  async #readOwnerKey(ownerUserId: string, providerId: string): Promise<string | undefined> {
    try {
      return (await this.#options.credentials.read(ownerUserId, providerId))?.secret;
    } catch (error) {
      if (error instanceof UnreadableCredentialError) {
        throw new Error("The owner's key is sealed under a key this instance does not hold", {
          cause: error,
        });
      }
      throw error;
    }
  }
}

/** The model's identifier at its provider, if `model` is that provider's. */
function modelIdFor(model: string | undefined, providerId: string): string | undefined {
  if (model === undefined) {
    return undefined;
  }
  const reference = parseModelReference(model);
  return reference.providerId === providerId ? reference.modelId : undefined;
}

function refused(refusal: ProxyRefusal, reason: string): ProxyAuthorization {
  return { kind: "refused", refusal, reason };
}
