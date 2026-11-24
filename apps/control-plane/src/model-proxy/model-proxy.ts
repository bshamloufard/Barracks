import type { IncomingMessage, ServerResponse } from "node:http";
import { type ModelProxyRequestTarget, parseModelProxyRequestTarget } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { ModelUsage } from "../model-usage/model-usage.js";
import { describeAnswerUsage } from "./answer-usage.js";
import type { ModelProxyAuthorization } from "./model-proxy-authorization.js";
import { ModelProxyAdmissions, type ModelProxyLimits } from "./model-proxy-limits.js";
import { readPresentedToken } from "./proxy-headers.js";
import { proxyRefusals, sendRefusal } from "./proxy-refusals.js";
import { type RelayOutcome, relayRequest } from "./relay-request.js";
import { findRelayedRoute, type RelayedRoute } from "./relayed-routes.js";

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
 * provider's API is relayed at (`relayed-routes.ts`); the thread must be
 * under its limits (`model-proxy-limits.ts`), which costs nothing to ask;
 * and the records must allow it (`ModelProxyAuthorization`). Then the
 * request is rebuilt for the provider's own address with its owner's key
 * (`relay-request.ts`), and the answer streamed back, its usage counted.
 *
 * Only metadata is logged: never a body, a header's value, or a key.
 */
export class ModelProxy {
  readonly #options: ModelProxyOptions;
  readonly #admissions: ModelProxyAdmissions;
  /** Each thread's requests in flight here, to end at once when the thread stops. */
  readonly #inFlight = new Map<string, Set<AbortController>>();

  constructor(options: ModelProxyOptions) {
    this.#options = options;
    this.#admissions = new ModelProxyAdmissions(options.limits);
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

  async #authorizeAndRelay(
    request: IncomingMessage,
    response: ServerResponse,
    target: ModelProxyRequestTarget,
    route: RelayedRoute,
    cancellation: AbortSignal,
    logger: Logger,
  ): Promise<void> {
    let authorization: Awaited<ReturnType<ModelProxyAuthorization["decide"]>>;
    try {
      authorization = await this.#options.authorization.decide({
        threadId: target.threadId,
        providerId: target.providerId,
        presentedToken: readPresentedToken(request.headers),
      });
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
      ownerKey: authorization.ownerKey,
      limits: this.#options.limits,
      cancellation,
    });
    await this.#recordUsage(target, authorization.ownerUserId, outcome);
    logger.info(
      {
        ownerUserId: authorization.ownerUserId,
        upstreamStatus: outcome.upstreamStatus ?? null,
        interruption: outcome.interruption ?? null,
        requestBytes: outcome.requestBytes,
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
  ): Promise<void> {
    const answerUsage = describeAnswerUsage(outcome);
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
