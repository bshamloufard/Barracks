import { findModelLimits } from "@barrack/model-catalogue";
import { type ProviderAccess, parseModelReference } from "@barrack/protocol";
import type { OwnerAdmission } from "../authentication/owner-admission.js";
import {
  type ChatGptPlanAccess,
  chatGptPlanProviderId,
  PlanRenewalUnavailableError,
} from "../chatgpt-plan/chatgpt-plan-access.js";
import type { OpenAiAccessAllowances } from "../chatgpt-plan/openai-access-allowances.js";
import { UnreadableCredentialError } from "../model-access/credential-keyring.js";
import type { ModelCredentials } from "../model-access/model-credentials.js";
import { describeReachedCap, type ModelUsage } from "../model-usage/model-usage.js";
import type { ThreadStore } from "../threads/thread-store.js";
import type { ModelProxyTokens, RememberedAcceptance } from "./model-proxy-tokens.js";
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
  openAiAccessAllowances: OpenAiAccessAllowances;
  tokens: ModelProxyTokens;
  credentials: ModelCredentials;
  ownerAdmission: OwnerAdmission;
  usage: ModelUsage;
  chatGptPlan: ChatGptPlanAccess;
};

/**
 * The owner may spend their access on the thread's requests: whose, what
 * (their API key, or for OpenAI possibly their ChatGPT plan), the secret
 * the provider is sent for it, and the thread's model.
 */
export type OwnerAuthorization = {
  kind: "allowed";
  ownerUserId: string;
  access: ProviderAccess;
  /** The owner's API key, or their plan's current access token. */
  ownerCredential: string;
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
 * key for that provider, or, where they chose it for OpenAI, a current
 * access token for their ChatGPT plan (or, for a run open when they
 * changed that, what the run began with: see `OpenAiAccessAllowances`); and the owner's usage cap not
 * reached (plan usage counts towards it like any other). Last, once
 * the body is read (`checkRequestedModels`), the model it names the
 * thread's own or that one before a switch. A request in flight is
 * checked again (`recheck`) without reading its credential again.
 *
 * The owner and the key or plan come from the thread named in the request
 * path, which is the thread the token was minted for, so a token can only
 * ever spend its own thread's owner's key or plan: there is no way to name
 * a user.
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

  /** Notes that a request let in with the token has ended (see `ModelProxyTokens.noteUsed`). */
  noteAuthenticationUsed(request: ProxyAuthorizationRequest, presentedToken: string): void {
    this.#options.tokens.noteUsed(request.threadId, request.providerId, presentedToken);
  }

  /**
   * What this instance remembers of the token, from memory alone (see
   * `ModelProxyTokens.recallAcceptance`): unless `fresh`, it must be looked
   * up.
   */
  recallAuthentication(
    request: ProxyAuthorizationRequest,
    presentedToken: string,
  ): RememberedAcceptance {
    return this.#options.tokens.recallAcceptance(
      request.threadId,
      request.providerId,
      presentedToken,
    );
  }

  /**
   * Whether an authenticated request may spend its owner's key, as far as
   * that can be known without its body. Throws when it cannot decide (the
   * database is unreachable, say), which is not a refusal.
   */
  async authorizeOwner(request: ProxyAuthorizationRequest): Promise<ProxyAuthorization> {
    const owner = await this.#checkThreadAndOwner(request);
    if (owner.kind === "refused") {
      return owner;
    }
    const { ownerUserId, threadModel } = owner;
    const access = await this.#findAccess(request, ownerUserId);
    const credential =
      access === "chatgpt_plan"
        ? await this.#readPlanToken(ownerUserId)
        : await this.#readOwnerKey(ownerUserId, request.providerId);
    if (credential.kind === "refused") {
      return credential;
    }
    const capRefused = await this.#checkCap(ownerUserId);
    if (capRefused !== undefined) {
      return capRefused;
    }
    return {
      kind: "allowed",
      ownerUserId,
      access,
      ownerCredential: credential.secret,
      threadModel,
    };
  }

  /**
   * Whether a request in flight, relayed as `relayed` allowed, may carry
   * on: everything `authorizeOwner` and `checkRequestedModels` decide,
   * except that the credential is not read again, only whether the owner
   * still holds the kind it was relayed with. The provider already holds
   * the secret it was sent, so a plan whose renewal is merely due, or that
   * OpenAI cannot renew just now, is no reason to cut its answer short;
   * a plan disconnected or a key removed is. Renewing is left to the next
   * request, so a long answer never renews the plan on its own. Throws
   * when it cannot decide.
   */
  async recheck(
    request: ProxyAuthorizationRequest,
    relayed: OwnerAuthorization,
    requested: RequestedModels | undefined,
  ): Promise<ProxyRefused | undefined> {
    const owner = await this.#checkThreadAndOwner(request);
    if (owner.kind === "refused") {
      return owner;
    }
    const credentialRefused = await this.#checkCredentialStillHeld(request, relayed);
    if (credentialRefused !== undefined) {
      return credentialRefused;
    }
    const capRefused = await this.#checkCap(owner.ownerUserId);
    if (capRefused !== undefined || requested === undefined) {
      return capRefused;
    }
    return this.checkRequestedModels(request, owner.threadModel, requested);
  }

  /**
   * OpenAI refused the access token of the owner's ChatGPT plan that a
   * request was sent with: the same owner's authorization with a token to
   * send it again with, the sign-in renewed (or renewed since by another
   * request), or why there is none. Throws when it cannot decide.
   */
  async renewRefusedPlan(owner: OwnerAuthorization): Promise<ProxyAuthorization> {
    try {
      const renewal = await this.#options.chatGptPlan.renewAfterRefusal(
        owner.ownerUserId,
        owner.ownerCredential,
      );
      switch (renewal.kind) {
        case "token":
          return { ...owner, ownerCredential: renewal.accessToken };
        case "not_connected":
          return refused(
            proxyRefusals.chatGptPlanNotConnected,
            "OpenAI would not renew the owner's ChatGPT plan, which is forgotten",
          );
        case "not_renewable_yet":
          return refused(
            proxyRefusals.chatGptPlanSignInRefused,
            "OpenAI refused the plan's access token, and its sign-in may not be renewed yet",
          );
      }
    } catch (error) {
      if (error instanceof PlanRenewalUnavailableError) {
        return refused(
          proxyRefusals.chatGptPlanRenewalUnavailable,
          "OpenAI could not renew the owner's ChatGPT plan just now",
        );
      }
      throw error;
    }
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

  /**
   * The thread's sandbox recorded running, the request's provider in use
   * by it, and its owner still admitted.
   */
  async #checkThreadAndOwner(
    request: ProxyAuthorizationRequest,
  ): Promise<
    { kind: "owner"; ownerUserId: string; threadModel: string | undefined } | ProxyRefused
  > {
    const thread = await this.#options.threadStore.find(request.threadId);
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
    return { kind: "owner", ownerUserId, threadModel: thread.model };
  }

  /**
   * What the owner chose to spend on the provider, unless they changed it
   * while the thread's run was open: then what the run began with, for
   * that run (see `OpenAiAccessAllowances`).
   */
  async #findAccess(
    request: ProxyAuthorizationRequest,
    ownerUserId: string,
  ): Promise<ProviderAccess> {
    const { chatGptPlan, openAiAccessAllowances } = this.#options;
    const current = await chatGptPlan.findAccess(ownerUserId, request.providerId);
    if (request.providerId !== chatGptPlanProviderId) {
      return current;
    }
    return (await openAiAccessAllowances.findRunAccess(request.threadId)) ?? current;
  }

  async #checkCredentialStillHeld(
    request: ProxyAuthorizationRequest,
    relayed: OwnerAuthorization,
  ): Promise<ProxyRefused | undefined> {
    if (relayed.access === "chatgpt_plan") {
      return (await this.#options.chatGptPlan.isConnected(relayed.ownerUserId))
        ? undefined
        : refused(
            proxyRefusals.chatGptPlanNotConnected,
            "the owner's ChatGPT plan is not connected",
          );
    }
    return (await this.#options.credentials.has(relayed.ownerUserId, request.providerId))
      ? undefined
      : refused(credentialMissingRefusal(request.providerId), "the owner has no key for it");
  }

  async #checkCap(ownerUserId: string): Promise<ProxyRefused | undefined> {
    const cap = await this.#options.usage.checkCap(ownerUserId);
    return cap.isReached
      ? refused(usageCapRefusal(describeReachedCap(cap)), "the owner's usage cap is reached")
      : undefined;
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
   * A plan's access token, renewed first if it is due; a plan no longer
   * connected is refused for good, one OpenAI cannot renew just now as
   * worth retrying.
   */
  async #readPlanToken(ownerUserId: string): Promise<OwnerCredential> {
    try {
      const token = await this.#options.chatGptPlan.findAccessToken(ownerUserId);
      return token.kind === "token"
        ? { kind: "found", secret: token.accessToken }
        : refused(
            proxyRefusals.chatGptPlanNotConnected,
            "the owner's ChatGPT plan is not connected",
          );
    } catch (error) {
      if (error instanceof PlanRenewalUnavailableError) {
        return refused(
          proxyRefusals.chatGptPlanRenewalUnavailable,
          "OpenAI could not renew the owner's ChatGPT plan just now",
        );
      }
      throw error;
    }
  }

  /**
   * A key sealed under a key this instance does not hold (another instance
   * rotated it, during a redeploy's overlap) is a reason to try again, not
   * a missing key: the agent retries, and normally reaches the other.
   */
  async #readOwnerKey(ownerUserId: string, providerId: string): Promise<OwnerCredential> {
    try {
      const key = (await this.#options.credentials.read(ownerUserId, providerId))?.secret;
      return key === undefined
        ? refused(credentialMissingRefusal(providerId), "the owner has no key for it")
        : { kind: "found", secret: key };
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
 * The models a request for `model` may name as `fallbacks`: those the
 * pinned agent sends for that very model (Anthropic's server-side
 * fallbacks, which it adds for some models), and for any other none. The
 * allow-list lets through only lists the agent sends, but for any model it
 * sends one for, so this ties the list to the model requested.
 */
function allowedFallbacks(providerId: string, model: string): readonly string[] {
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

type OwnerCredential = { kind: "found"; secret: string } | ProxyRefused;

function refused(refusal: ProxyRefusal, reason: string): ProxyRefused {
  return { kind: "refused", refusal, reason };
}
