import { findModelLimits } from "@barrack/model-catalogue";
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

/** The owner may spend their key on the thread's requests: whose key, the key, and the thread's model. */
export type OwnerAuthorization = {
  kind: "allowed";
  ownerUserId: string;
  ownerKey: string;
  threadModel: string | undefined;
};

export type ProxyRefused = { kind: "refused"; refusal: ProxyRefusal; reason: string };

/** Allowed: whose key to use, and the key itself, for this one request. */
export type ProxyAuthorization = OwnerAuthorization | ProxyRefused;

/**
 * Decides, for each request, whether the model proxy may spend a user's key
 * on it, from the records alone, read afresh every time so a change takes
 * effect on the next request. First, alone, whether the caller presents a
 * token minted for this very thread and provider (`authenticate`, see
 * `ModelProxyTokens`), before anything else is spent on the request; then,
 * before its body is read, what needs no body (`authorizeOwner`): the
 * thread's sandbox recorded running; the provider the thread's model's, or
 * that of the model before a switch made while the run still open began
 * (see `ModelSwitchAllowances`); its owner still admitted; the owner's own
 * key for that provider; and the owner's usage cap not reached. Last, once
 * the body is read (`checkRequestedModels`), the model it names the
 * thread's own or that one before a switch.
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
   * Whether an authenticated request may spend its owner's key, as far as
   * that can be known without its body. Throws when it cannot decide (the
   * database is unreachable, say), which is not a refusal.
   */
  async authorizeOwner(request: ProxyAuthorizationRequest): Promise<ProxyAuthorization> {
    const { threadId, providerId } = request;
    const thread = await this.#options.threadStore.find(threadId);
    const ownerUserId = thread?.ownerUserId;
    if (thread === undefined || ownerUserId === undefined) {
      return refused(proxyRefusals.tokenRefused, "the thread is gone");
    }
    if (thread.sandbox.state !== "running") {
      return refused(proxyRefusals.tokenRefused, `its sandbox is ${thread.sandbox.state}`);
    }
    const providerRefused = await this.#checkProviderInUse(request, thread.model);
    if (providerRefused !== undefined) {
      return providerRefused;
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
    return { kind: "allowed", ownerUserId, ownerKey, threadModel: thread.model };
  }

  /**
   * The agent asks only for the thread's model (the pinned agent's
   * compaction and summaries use the model it runs on too), so a request
   * for any other is refused: otherwise a sandbox could spend its owner's
   * key on the dearest model the key allows. The one exception is the
   * model before a switch, for the run still open on it. `fallbacks`
   * may name only what `allowedFallbacks` allows. Throws when it cannot
   * decide.
   */
  async checkRequestedModels(
    request: ProxyAuthorizationRequest,
    threadModel: string | undefined,
    requested: RequestedModels,
  ): Promise<ProxyRefused | undefined> {
    const { threadId, providerId } = request;
    const current = modelIdFor(threadModel, providerId);
    const isOwnModel =
      requested.model === current ||
      requested.model ===
        modelIdFor(
          await this.#options.modelSwitchAllowances.findPreviousModel(threadId),
          providerId,
        );
    const allowed = allowedFallbacks(providerId, requested.model);
    const areFallbacksAllowed = requested.fallbackModels.every((fallback) =>
      allowed.includes(fallback),
    );
    if (!isOwnModel || !areFallbacksAllowed) {
      return refused(modelRefusal(threadModel ?? "none"), "the request names another model");
    }
    return undefined;
  }

  /** Both of the above, for a request in flight checked again. */
  async decide(
    request: ProxyAuthorizationRequest,
    requested: RequestedModels | undefined,
  ): Promise<ProxyAuthorization> {
    const owner = await this.authorizeOwner(request);
    if (owner.kind === "refused" || requested === undefined) {
      return owner;
    }
    return (await this.checkRequestedModels(request, owner.threadModel, requested)) ?? owner;
  }

  /**
   * A thread's requests go to its model's provider, or to the provider of
   * the model before a switch while that run lasts. A provider in use by
   * neither has its tokens retired.
   */
  async #checkProviderInUse(
    request: ProxyAuthorizationRequest,
    threadModel: string | undefined,
  ): Promise<ProxyRefused | undefined> {
    const { threadId, providerId } = request;
    if (modelIdFor(threadModel, providerId) !== undefined) {
      return undefined;
    }
    const previousModel = await this.#options.modelSwitchAllowances.findPreviousModel(threadId);
    if (modelIdFor(previousModel, providerId) !== undefined) {
      return undefined;
    }
    const providersInUse = [threadModel, previousModel].flatMap((model) =>
      model === undefined ? [] : [parseModelReference(model).providerId],
    );
    await this.#options.tokens.retainProviders(threadId, providersInUse);
    return refused(proxyRefusals.tokenRefused, "the thread runs on another provider now");
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

/**
 * The models a request for `model` may name as `fallbacks`: for Anthropic,
 * those the pinned agent sends for that very model (its server-side
 * fallbacks, which it adds for some models); for OpenRouter's Anthropic
 * format, where the field is OpenRouter's own routing to other models,
 * only the model itself; for any other provider, none.
 */
function allowedFallbacks(providerId: string, model: string): readonly string[] {
  if (providerId === "openrouter") {
    return [model];
  }
  return findModelLimits(providerId, model)?.fallbackModelIds ?? [];
}

/** The model's identifier at its provider, if `model` is that provider's. */
function modelIdFor(model: string | undefined, providerId: string): string | undefined {
  if (model === undefined) {
    return undefined;
  }
  const reference = parseModelReference(model);
  return reference.providerId === providerId ? reference.modelId : undefined;
}

function refused(refusal: ProxyRefusal, reason: string): ProxyRefused {
  return { kind: "refused", refusal, reason };
}
