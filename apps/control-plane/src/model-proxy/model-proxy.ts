import type { IncomingMessage, ServerResponse } from "node:http";
import { type ModelProxyRequestTarget, parseModelProxyRequestTarget } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { ModelUsage } from "../model-usage/model-usage.js";
import { describeAnswerUsage, type RequestedAnswer } from "./answer-usage.js";
import type { ModelProxyAuthorization } from "./model-proxy-authorization.js";
import {
  AuthenticationAllowance,
  ModelProxyAdmissions,
  type ModelProxyLimits,
} from "./model-proxy-limits.js";
import { ModelProxyTokens } from "./model-proxy-tokens.js";
import { readPresentedToken } from "./proxy-headers.js";
import { type ProxyRefusal, proxyRefusals, sendRefusal } from "./proxy-refusals.js";
import { type RelayOutcome, relayRequest } from "./relay-request.js";
import { findRelayedRoute, type RelayedRoute } from "./relayed-routes.js";
import {
  type BodyReading,
  inspectRequestBody,
  type RelayedRequestBody,
  RequestBodyBudget,
} from "./request-body.js";

/** One request on its way through the proxy, and what it is relayed with. */
type RelayedExchange = {
  request: IncomingMessage;
  response: ServerResponse;
  target: ModelProxyRequestTarget;
  route: RelayedRoute;
  cancellation: AbortSignal;
  logger: Logger;
};

/** Why a body was not read: too large is the agent's to fix; the rest are worth retrying. */
const bodyReadingRefusals: Record<Exclude<BodyReading["kind"], "read">, ProxyRefusal> = {
  too_large: proxyRefusals.requestTooLarge,
  proxy_busy: proxyRefusals.proxyBusy,
  agent_went_away: proxyRefusals.upstreamUnreachable,
};

export type ModelProxyOptions = {
  authorization: ModelProxyAuthorization;
  usage: ModelUsage;
  limits: ModelProxyLimits;
  /** For tests and local development only: replaces every provider's scheme, host and port. */
  upstreamOrigin: string | undefined;
  logger: Logger;
};

/**
 * The control plane's model proxy: where a thread's agent sends requests
 * for a provider whose key stays on the server, at
 * `/threads/{threadId}/model-proxy/{providerId}/…`, outside `/api` because
 * the caller is a sandbox, proven by its token, not a signed-in user.
 *
 * In order, before anything is forwarded: the path must be one the
 * provider's API is relayed at (`relayed-routes.ts`); the caller must
 * present the thread's token for the provider, looked up within the
 * instance's bound on callers not yet authenticated; the thread must be
 * under its own limits (`model-proxy-limits.ts`); and the records must
 * allow it (`ModelProxyAuthorization`). Then the
 * request is rebuilt for the provider's own address with its owner's key
 * (`relay-request.ts`), and the answer streamed back, its usage counted.
 *
 * Only metadata is logged: never a body, a header's value, or a key.
 */
export class ModelProxy {
  readonly #options: ModelProxyOptions;
  readonly #authentications: AuthenticationAllowance;
  readonly #admissions: ModelProxyAdmissions;
  readonly #requestBodies: RequestBodyBudget;
  /** Each thread's requests in flight here, to end at once when the thread stops. */
  readonly #inFlight = new Map<string, Set<AbortController>>();

  constructor(options: ModelProxyOptions) {
    this.#options = options;
    this.#authentications = new AuthenticationAllowance(options.limits);
    this.#admissions = new ModelProxyAdmissions(options.limits);
    this.#requestBodies = new RequestBodyBudget(options.limits.maximumRequestBytesHeldInTotal);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // A refused request's body is never read, so its connection is not reused.
    response.shouldKeepAlive = false;
    const target = parseModelProxyRequestTarget(request.url ?? "");
    if (!target.ok) {
      sendRefusal(response, undefined, proxyRefusals.notFound);
      return;
    }
    const lookup = findRelayedRoute(
      { ...target.value, method: request.method ?? "" },
      this.#options.upstreamOrigin,
    );
    if (lookup.kind !== "found") {
      sendRefusal(
        response,
        undefined,
        lookup.kind === "method_not_allowed"
          ? proxyRefusals.methodNotAllowed
          : proxyRefusals.notFound,
      );
      return;
    }
    await this.#admitAndRelay(request, response, target.value, lookup.route);
  }

  /** Ends the thread's requests in flight here: its sandbox is stopping, or the thread is being deleted. */
  cancelThread(threadId: string): void {
    for (const cancellation of this.#inFlight.get(threadId) ?? []) {
      cancellation.abort();
    }
  }

  async #admitAndRelay(
    request: IncomingMessage,
    response: ServerResponse,
    target: ModelProxyRequestTarget,
    route: RelayedRoute,
  ): Promise<void> {
    const { threadId, providerId } = target;
    const logger = this.#options.logger.child({ threadId, providerId });
    if (!(await this.#authenticate(request, response, target, route, logger))) {
      return;
    }
    const admission = this.#admissions.admit(threadId);
    if (admission.kind !== "admitted") {
      logger.warn({ limit: admission.kind }, "Refused a model request over the proxy's limits");
      sendRefusal(
        response,
        route.format,
        admission.kind === "thread_busy" ? proxyRefusals.tooManyAtOnce : proxyRefusals.proxyBusy,
      );
      return;
    }
    if (Number(request.headers["content-length"] ?? 0) > this.#options.limits.maximumRequestBytes) {
      admission.release();
      sendRefusal(response, route.format, proxyRefusals.requestTooLarge);
      return;
    }
    const cancellation = new AbortController();
    this.#trackInFlight(threadId, cancellation);
    try {
      await this.#authorizeAndRelay(request, response, target, route, cancellation.signal, logger);
    } finally {
      this.#untrackInFlight(threadId, cancellation);
      admission.release();
    }
  }

  /**
   * Whether the request presents its thread's token for this provider,
   * refusing it if not. Nothing else is spent on a request before this: a
   * token that could not be one is refused without a lookup, and lookups for
   * callers not yet authenticated are bounded for the whole instance, so
   * nobody who lacks the token can use up a thread's allowance or make the
   * database work without limit. The refusal is the same whether the thread
   * exists or not.
   */
  async #authenticate(
    request: IncomingMessage,
    response: ServerResponse,
    target: ModelProxyRequestTarget,
    route: RelayedRoute,
    logger: Logger,
  ): Promise<boolean> {
    const presentedToken = readPresentedToken(request.headers);
    if (presentedToken === undefined || !ModelProxyTokens.isWellFormed(presentedToken)) {
      sendRefusal(response, route.format, proxyRefusals.tokenRefused);
      return false;
    }
    const lookup = this.#authentications.enter();
    if (lookup.kind === "busy") {
      logger.warn("Refused a model request: too many token lookups at once on this instance");
      sendRefusal(response, route.format, proxyRefusals.proxyBusy);
      return false;
    }
    try {
      if (await this.#options.authorization.authenticate(target, presentedToken)) {
        return true;
      }
      sendRefusal(response, route.format, proxyRefusals.tokenRefused);
      return false;
    } catch (error) {
      logger.error({ err: error }, "Could not check a model request's token");
      sendRefusal(response, route.format, proxyRefusals.cannotDecide);
      return false;
    } finally {
      lookup.leave();
    }
  }

  async #authorizeAndRelay(
    request: IncomingMessage,
    response: ServerResponse,
    target: ModelProxyRequestTarget,
    route: RelayedRoute,
    cancellation: AbortSignal,
    logger: Logger,
  ): Promise<void> {
    const reading = await this.#readBody(request, response);
    if (reading.kind !== "read") {
      sendRefusal(response, route.format, bodyReadingRefusals[reading.kind]);
      return;
    }
    try {
      const inspection = inspectRequestBody(route.format, reading.bytes);
      if (inspection.kind === "refused") {
        logger.warn({ reason: inspection.reason }, "Refused a model request's body");
        sendRefusal(response, route.format, inspection.refusal);
        return;
      }
      const requested: RequestedAnswer = {
        model: inspection.body.model,
        requestBytes: reading.bytes.length,
        maximumOutputTokens: inspection.body.maximumOutputTokens,
        isStreamed: inspection.body.isStreamed,
      };
      await this.#decideAndRelay(
        { request, response, target, route, cancellation, logger },
        inspection.body,
        requested,
      );
    } finally {
      reading.release();
    }
  }

  /**
   * Reads the whole body, so it can be checked before anything reaches the
   * provider; an agent that goes silent while sending it is cut off after
   * the idle limit.
   */
  async #readBody(request: IncomingMessage, response: ServerResponse): Promise<BodyReading> {
    const cutOff = () => request.destroy();
    response.setTimeout(this.#options.limits.idleTimeoutInMilliseconds);
    response.once("timeout", cutOff);
    try {
      return await this.#requestBodies.read(request, this.#options.limits.maximumRequestBytes);
    } finally {
      response.removeListener("timeout", cutOff);
    }
  }

  async #decideAndRelay(
    relayed: RelayedExchange,
    body: RelayedRequestBody,
    requested: RequestedAnswer,
  ): Promise<void> {
    const { request, response, target, route, cancellation, logger } = relayed;
    let authorization: Awaited<ReturnType<ModelProxyAuthorization["decide"]>>;
    try {
      authorization = await this.#options.authorization.decide(target);
    } catch (error) {
      logger.error({ err: error }, "Could not decide whether to relay a model request");
      sendRefusal(response, route.format, proxyRefusals.cannotDecide);
      return;
    }
    if (authorization.kind === "refused") {
      logger.warn({ reason: authorization.reason }, "Refused a model request");
      sendRefusal(response, route.format, authorization.refusal);
      return;
    }
    response.shouldKeepAlive = true;
    const startedAt = Date.now();
    const outcome = await relayRequest({
      request,
      response,
      route,
      body: body.bytes,
      ownerKey: authorization.ownerKey,
      limits: this.#options.limits,
      cancellation,
    });
    await this.#recordUsage(target, authorization.ownerUserId, outcome, requested);
    logger.info(
      {
        ownerUserId: authorization.ownerUserId,
        upstreamStatus: outcome.upstreamStatus ?? null,
        interruption: outcome.interruption ?? null,
        requestBytes: requested.requestBytes,
        responseBytes: outcome.responseBytes,
        durationInMilliseconds: Date.now() - startedAt,
      },
      "Relayed a model request",
    );
  }

  async #recordUsage(
    target: ModelProxyRequestTarget,
    ownerUserId: string,
    outcome: RelayOutcome,
    requested: RequestedAnswer,
  ): Promise<void> {
    const answerUsage = describeAnswerUsage(outcome, requested);
    if (answerUsage === undefined) {
      return;
    }
    await this.#options.usage.record({
      ownerUserId,
      threadId: target.threadId,
      providerId: target.providerId,
      ...answerUsage,
    });
  }

  #trackInFlight(threadId: string, cancellation: AbortController): void {
    const cancellations = this.#inFlight.get(threadId) ?? new Set();
    cancellations.add(cancellation);
    this.#inFlight.set(threadId, cancellations);
  }

  #untrackInFlight(threadId: string, cancellation: AbortController): void {
    const cancellations = this.#inFlight.get(threadId);
    cancellations?.delete(cancellation);
    if (cancellations?.size === 0) {
      this.#inFlight.delete(threadId);
    }
  }
}
