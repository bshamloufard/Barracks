import type { IncomingMessage, ServerResponse } from "node:http";
import { parseModelProxyRequestTarget } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { ModelUsage } from "../model-usage/model-usage.js";
import {
  describeAnswerUsage,
  mayReasonUnseen,
  type RequestedAnswer,
  resolveMaximumOutputTokens,
} from "./answer-usage.js";
import type {
  ModelProxyAuthorization,
  OwnerAuthorization,
  RequestedModels,
} from "./model-proxy-authorization.js";
import {
  AuthenticationAllowance,
  ModelProxyAdmissions,
  type ModelProxyLimits,
} from "./model-proxy-limits.js";
import { ModelProxyTokens } from "./model-proxy-tokens.js";
import { type ExchangeEnding, ProxyExchange } from "./proxy-exchange.js";
import { readPresentedToken } from "./proxy-headers.js";
import { type ProxyRefusal, proxyRefusals, sendRefusal } from "./proxy-refusals.js";
import { relayRequest } from "./relay-request.js";
import { findRelayedRoute } from "./relayed-routes.js";
import {
  inspectRequestBody,
  type RelayedRequestBody,
  requestBodyShapeLimits,
} from "./request-body.js";
import { type BodyReading, RequestBodyBudget } from "./request-body-budget.js";

/**
 * Why a body was not read: too large is the agent's to fix; the rest are
 * worth retrying.
 */
const bodyReadingRefusals: Record<
  Exclude<BodyReading["kind"], "read" | "ended" | "invalid">,
  ProxyRefusal
> = {
  too_large: proxyRefusals.requestTooLarge,
  instance_busy: proxyRefusals.proxyBusy,
  share_used: proxyRefusals.tooManyBytesAtOnce,
  too_slow: proxyRefusals.requestBodyTooSlow,
  agent_went_away: proxyRefusals.upstreamUnreachable,
};

/** What a request ended by the proxy is told, if the agent is still there to hear it. */
const endingRefusals: Record<ExchangeEnding, ProxyRefusal> = {
  agent_went_away: proxyRefusals.upstreamUnreachable,
  thread_ended: proxyRefusals.tokenRefused,
  no_longer_authorized: proxyRefusals.tokenRefused,
  shutting_down: proxyRefusals.proxyBusy,
};

/**
 * What the proxy holds at this moment, for tests and the log at shutdown:
 * once no request is under way, every count is zero.
 */
export type ModelProxyActivity = {
  /** Requests the proxy is handling, from their arrival to their end. */
  requestsOpen: number;
  /** Of those, the ones admitted within the threads' and the instance's limits. */
  requestsAdmitted: number;
  tokenLookupsUnderWay: number;
  requestBodyBytesHeld: number;
  /** Requests whose records are checked again on a timer while they last. */
  recordsChecksScheduled: number;
};

export const idleModelProxyActivity: ModelProxyActivity = {
  requestsOpen: 0,
  requestsAdmitted: 0,
  tokenLookupsUnderWay: 0,
  requestBodyBytesHeld: 0,
  recordsChecksScheduled: 0,
};

export type ModelProxyOptions = {
  authorization: ModelProxyAuthorization;
  usage: ModelUsage;
  limits: ModelProxyLimits;
  /** For tests and local development only: replaces every provider's scheme, host and port. */
  upstreamOrigin: string | undefined;
  logger: Logger;
};

/** Where a request's re-checks find the models it names, once its body is read. */
type Recheck = { requested: RequestedModels | undefined };

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
 * under its own limits (`model-proxy-limits.ts`); the records must allow
 * its owner's key to be spent (`ModelProxyAuthorization`); the body, read
 * whole within its shares of the bytes held (`request-body-budget.ts`),
 * must pass its checks (`request-body.ts`); and the models it names must
 * be the thread's. Then the request is rebuilt for the provider's own
 * address with its owner's key (`relay-request.ts`), the answer streamed
 * back, its usage counted, and the records checked again while it lasts.
 *
 * Each request is a `ProxyExchange`, which holds whatever the request
 * takes and gives all of it back when the request ends, however it ends:
 * the agent hanging up at any point, its thread stopping, or the proxy
 * shutting down. After every wait, a request that has been ended goes no
 * further.
 *
 * Only metadata is logged: never a body, a header's value, or a key.
 */
export class ModelProxy {
  readonly #options: ModelProxyOptions;
  readonly #authentications: AuthenticationAllowance;
  readonly #admissions: ModelProxyAdmissions;
  readonly #requestBodies: RequestBodyBudget;
  /** Every request under way here, by the thread its path names. */
  readonly #exchanges = new Map<string, Set<ProxyExchange>>();
  /** Each request's handling, from its arrival to the end of recording its usage. */
  readonly #handlings = new Set<Promise<void>>();
  #recordsChecksScheduled = 0;
  #isShuttingDown = false;

  constructor(options: ModelProxyOptions) {
    this.#options = options;
    this.#authentications = new AuthenticationAllowance(options.limits);
    this.#admissions = new ModelProxyAdmissions(options.limits);
    this.#requestBodies = new RequestBodyBudget(options.limits.maximumRequestBytesHeldInTotal);
  }

  get activity(): ModelProxyActivity {
    let requestsOpen = 0;
    for (const exchanges of this.#exchanges.values()) {
      requestsOpen += exchanges.size;
    }
    return {
      requestsOpen,
      requestsAdmitted: this.#admissions.inFlightInTotal,
      tokenLookupsUnderWay: this.#authentications.inFlight,
      requestBodyBytesHeld: this.#requestBodies.held,
      recordsChecksScheduled: this.#recordsChecksScheduled,
    };
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const handling = this.#handle(request, response);
    this.#handlings.add(handling);
    try {
      await handling;
    } finally {
      this.#handlings.delete(handling);
    }
  }

  /**
   * Ends every request in flight here, as the control plane shuts down,
   * and refuses any that arrive after, as busy, which the agent retries
   * (normally reaching the instance that replaces this one); then waits,
   * at most `gracePeriodInMilliseconds`, for each to finish recording its
   * usage, estimated where the answer was cut short. A request left to
   * run until the platform killed the process would be counted nothing.
   * Returns what the proxy still holds, which is nothing unless the grace
   * period ran out, and logs it.
   */
  async shutDown(gracePeriodInMilliseconds: number): Promise<ModelProxyActivity> {
    this.#isShuttingDown = true;
    for (const exchanges of this.#exchanges.values()) {
      for (const exchange of exchanges) {
        exchange.end("shutting_down");
      }
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.#handlings]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, gracePeriodInMilliseconds);
      }),
    ]);
    clearTimeout(timer);
    const left = this.activity;
    this.#options.logger.info({ ...left }, "The model proxy has ended its requests");
    return left;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (isPipelined(response)) {
      this.#options.logger.warn(
        "Ended a connection that sent a model request before the answer ahead of it had ended",
      );
      request.socket.destroy();
      return;
    }
    // A refused request's body is never read, so its connection is not reused.
    response.shouldKeepAlive = false;
    if (this.#isShuttingDown) {
      sendRefusal(response, undefined, proxyRefusals.proxyBusy);
      return;
    }
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
    const { threadId, providerId } = target.value;
    const exchange = new ProxyExchange({
      request,
      response,
      target: target.value,
      route: lookup.route,
      logger: this.#options.logger.child({ threadId, providerId }),
    });
    this.#track(exchange);
    try {
      await this.#serve(exchange);
    } finally {
      exchange.close();
    }
  }

  /** Ends the thread's requests in flight here: its sandbox is stopping, or the thread is being deleted. */
  cancelThread(threadId: string): void {
    for (const exchange of this.#exchanges.get(threadId) ?? []) {
      exchange.end("thread_ended");
    }
  }

  /**
   * The request's way through the proxy, in the order that spends least on
   * a request that will be refused: its token; its thread's limits; the
   * records about its thread and owner, which need no body; its body, read
   * within its thread's and owner's shares and checked as it arrives; the
   * models it names; and only then the provider. From the records on, they
   * are checked again on a timer for as long as the request lasts.
   */
  async #serve(exchange: ProxyExchange): Promise<void> {
    const presentedToken = await this.#authenticate(exchange);
    if (presentedToken === undefined || this.#refuseIfEnded(exchange) || !this.#admit(exchange)) {
      return;
    }
    const owner = await this.#authorizeOwner(exchange);
    if (owner === undefined || this.#refuseIfEnded(exchange)) {
      return;
    }
    const recheck = this.#keepAuthorized(exchange, presentedToken);
    const body = await this.#readAndInspectBody(exchange, owner);
    if (body === undefined) {
      return;
    }
    recheck.requested = body;
    const isModelAllowed = await this.#checkRequestedModels(exchange, owner, body);
    if (!isModelAllowed || this.#refuseIfEnded(exchange)) {
      return;
    }
    await this.#relay(exchange, body, owner);
  }

  /**
   * The token the request presents, if it is its thread's for this
   * provider; otherwise the request is refused, and undefined returned.
   * Nothing else is spent on a request before this: a token that could not
   * be one is refused without a lookup, and lookups for callers not yet
   * authenticated are bounded for the whole instance, so nobody who lacks
   * the token can use up a thread's allowance or make the database work
   * without limit. A token a lookup accepted in the last 30 seconds is
   * accepted again without one, outside that bound, and one accepted more
   * than 15 seconds ago is looked up again outside it too (only a caller
   * holding a remembered token gets that far), so strangers using the
   * bound up cannot keep a working agent out however long it works. The
   * refusal is the same whether the thread exists or not.
   */
  async #authenticate(exchange: ProxyExchange): Promise<string | undefined> {
    const { request, response, route, target, logger } = exchange;
    const presentedToken = readPresentedToken(request.headers);
    if (presentedToken === undefined || !ModelProxyTokens.isWellFormed(presentedToken)) {
      sendRefusal(response, route.format, proxyRefusals.tokenRefused);
      return undefined;
    }
    switch (this.#options.authorization.recallAuthentication(target, presentedToken)) {
      case "fresh":
        return presentedToken;
      case "due_for_renewal":
        return this.#lookUpToken(exchange, presentedToken);
      case "not_remembered":
        break;
    }
    const lookup = this.#authentications.enter();
    if (lookup.kind === "busy") {
      logger.warn("Refused a model request: too many token lookups at once on this instance");
      sendRefusal(response, route.format, proxyRefusals.proxyBusy);
      return undefined;
    }
    try {
      return await this.#lookUpToken(exchange, presentedToken);
    } finally {
      lookup.leave();
    }
  }

  /** The token, if the store accepts it for the request's thread and provider; otherwise refuses the request. */
  async #lookUpToken(exchange: ProxyExchange, presentedToken: string): Promise<string | undefined> {
    const { response, route, target, logger } = exchange;
    try {
      if (await this.#options.authorization.authenticate(target, presentedToken)) {
        return presentedToken;
      }
      sendRefusal(response, route.format, proxyRefusals.tokenRefused);
      return undefined;
    } catch (error) {
      logger.error({ err: error }, "Could not check a model request's token");
      sendRefusal(response, route.format, proxyRefusals.cannotDecide);
      return undefined;
    }
  }

  /** Admits the request within its thread's and the instance's limits, or refuses it. */
  #admit(exchange: ProxyExchange): boolean {
    const { request, response, route, target, logger } = exchange;
    const admission = this.#admissions.admit(target.threadId);
    if (admission.kind !== "admitted") {
      logger.warn({ limit: admission.kind }, "Refused a model request over the proxy's limits");
      sendRefusal(
        response,
        route.format,
        admission.kind === "thread_busy" ? proxyRefusals.tooManyAtOnce : proxyRefusals.proxyBusy,
      );
      return false;
    }
    exchange.hold(admission.release);
    if (Number(request.headers["content-length"] ?? 0) > this.#options.limits.maximumRequestBytes) {
      sendRefusal(response, route.format, proxyRefusals.requestTooLarge);
      return false;
    }
    return true;
  }

  /** Whether the records allow the request before its body is read: its owner's key if so. */
  async #authorizeOwner(exchange: ProxyExchange): Promise<OwnerAuthorization | undefined> {
    const { response, target, route, logger } = exchange;
    try {
      const authorization = await this.#options.authorization.authorizeOwner(target);
      if (authorization.kind === "allowed") {
        return authorization;
      }
      logger.warn({ reason: authorization.reason }, "Refused a model request");
      sendRefusal(response, route.format, authorization.refusal);
      return undefined;
    } catch (error) {
      logger.error({ err: error }, "Could not decide whether to relay a model request");
      sendRefusal(response, route.format, proxyRefusals.cannotDecide);
      return undefined;
    }
  }

  /**
   * Reads the whole body, so it can be checked before anything reaches the
   * provider, and checks it; an agent that goes silent while sending it is
   * cut off after the idle limit, and one that sends it too slowly at the
   * body's deadline. Undefined once the request is refused.
   */
  async #readAndInspectBody(
    exchange: ProxyExchange,
    owner: OwnerAuthorization,
  ): Promise<RelayedRequestBody | undefined> {
    const { request, response, route, target, logger } = exchange;
    const { limits } = this.#options;
    const cutOff = () => request.destroy();
    response.setTimeout(limits.idleTimeoutInMilliseconds);
    response.once("timeout", cutOff);
    const reading = await this.#requestBodies
      .read(
        request,
        {
          maximumBytes: limits.maximumRequestBytes,
          deadlineInMilliseconds: limits.requestBodyDeadlineInMilliseconds,
          threadId: target.threadId,
          ownerUserId: owner.ownerUserId,
          scannerLimits: requestBodyShapeLimits,
        },
        exchange.signal,
      )
      .finally(() => response.removeListener("timeout", cutOff));
    if (reading.kind === "ended") {
      this.#refuseIfEnded(exchange);
      return undefined;
    }
    if (reading.kind === "invalid") {
      logger.warn({ reason: reading.reason }, "Refused a model request's body");
      sendRefusal(response, route.format, proxyRefusals.invalidRequestBody);
      return undefined;
    }
    if (reading.kind !== "read") {
      logger.warn({ reason: reading.kind }, "Did not read a model request's body");
      sendRefusal(response, route.format, bodyReadingRefusals[reading.kind]);
      return undefined;
    }
    exchange.hold(reading.held.release);
    const inspection = inspectRequestBody(
      route.format,
      target.providerId,
      reading.bytes,
      reading.scanned,
      limits.maximumRequestBytes,
    );
    if (inspection.kind === "refused") {
      logger.warn({ reason: inspection.reason }, "Refused a model request's body");
      sendRefusal(response, route.format, inspection.refusal);
      return undefined;
    }
    const growthRefused = reading.held.resize(inspection.body.bytes.length);
    if (growthRefused !== undefined) {
      logger.warn({ reason: growthRefused }, "Did not relay a model request's rewritten body");
      sendRefusal(response, route.format, bodyReadingRefusals[growthRefused]);
      return undefined;
    }
    return inspection.body;
  }

  /** Whether the models the body names are ones the thread may use; refuses the request if not. */
  async #checkRequestedModels(
    exchange: ProxyExchange,
    owner: OwnerAuthorization,
    body: RelayedRequestBody,
  ): Promise<boolean> {
    const { response, target, route, logger } = exchange;
    try {
      const refusal = await this.#options.authorization.checkRequestedModels(
        target,
        owner.threadModel,
        body,
      );
      if (refusal === undefined) {
        return true;
      }
      logger.warn({ reason: refusal.reason }, "Refused a model request");
      sendRefusal(response, route.format, refusal.refusal);
      return false;
    } catch (error) {
      logger.error({ err: error }, "Could not decide whether to relay a model request");
      sendRefusal(response, route.format, proxyRefusals.cannotDecide);
      return false;
    }
  }

  async #relay(
    exchange: ProxyExchange,
    body: RelayedRequestBody,
    owner: OwnerAuthorization,
  ): Promise<void> {
    const { request, response, target, route, logger } = exchange;
    const requested: RequestedAnswer = {
      model: body.model,
      isStreamed: body.isStreamed,
      estimatedInputTokens: body.estimatedInputTokens,
      maximumOutputTokens: resolveMaximumOutputTokens(
        target.providerId,
        body.model,
        body.maximumOutputTokens,
      ),
      mayReasonUnseen: mayReasonUnseen(target.providerId, body.model, body.reasoningRequest),
    };
    response.shouldKeepAlive = true;
    const startedAt = Date.now();
    const outcome = await relayRequest({
      request,
      response,
      route,
      body: body.bytes,
      ownerKey: owner.ownerKey,
      limits: this.#options.limits,
      cancellation: exchange.signal,
    });
    const answerUsage = describeAnswerUsage(outcome, requested);
    if (answerUsage !== undefined) {
      await this.#options.usage.record({
        ownerUserId: owner.ownerUserId,
        threadId: target.threadId,
        providerId: target.providerId,
        ...answerUsage,
      });
    }
    logger.info(
      {
        ownerUserId: owner.ownerUserId,
        upstreamStatus: outcome.upstreamStatus ?? null,
        interruption: outcome.interruption ?? null,
        requestBytes: body.bytes.length,
        responseBytes: outcome.responseBytes,
        durationInMilliseconds: Date.now() - startedAt,
      },
      "Relayed a model request",
    );
  }

  /**
   * Checks a request in flight against the records again every
   * `reauthorizationIntervalInMilliseconds`, ending it once its token is
   * revoked, its thread no longer runs, its owner is no longer admitted,
   * their key is gone, their cap is reached, or (once its body is read)
   * the models it names are no longer allowed. A stop handled by this
   * instance ends the thread's requests at once (`cancelThread`); this is
   * what ends them when the other instance handled it, during a redeploy's
   * overlap. A check that cannot be made lets the request carry on, as a
   * database that cannot be asked is no reason to cut an answer short. The
   * checks stop when the exchange closes.
   */
  #keepAuthorized(exchange: ProxyExchange, presentedToken: string): Recheck {
    const recheck: Recheck = { requested: undefined };
    let isChecking = false;
    const check = () => {
      if (isChecking) {
        return;
      }
      isChecking = true;
      this.#isStillAuthorized(exchange, presentedToken, recheck.requested)
        .then(
          (isAuthorized) => {
            if (!isAuthorized) {
              exchange.end("no_longer_authorized");
            }
          },
          (error: unknown) =>
            exchange.logger.warn(
              { err: error },
              "Could not check a model request in flight again; it carries on",
            ),
        )
        .finally(() => {
          isChecking = false;
        });
    };
    const timer = setInterval(check, this.#options.limits.reauthorizationIntervalInMilliseconds);
    this.#recordsChecksScheduled += 1;
    exchange.hold(() => {
      clearInterval(timer);
      this.#recordsChecksScheduled -= 1;
    });
    return recheck;
  }

  async #isStillAuthorized(
    exchange: ProxyExchange,
    presentedToken: string,
    requested: RequestedModels | undefined,
  ): Promise<boolean> {
    const { authorization } = this.#options;
    const { target, logger } = exchange;
    if (!(await authorization.authenticate(target, presentedToken))) {
      logger.warn("Ended a model request in flight: its token was revoked");
      return false;
    }
    const decision = await authorization.decide(target, requested);
    if (decision.kind === "refused") {
      logger.warn({ reason: decision.reason }, "Ended a model request in flight");
      return false;
    }
    return true;
  }

  /**
   * Whether the request was ended while it waited (and if so, tells the
   * agent why, if it is still there): it then goes no further.
   */
  #refuseIfEnded(exchange: ProxyExchange): boolean {
    const { ending } = exchange;
    if (ending === undefined) {
      return false;
    }
    sendRefusal(exchange.response, exchange.route.format, endingRefusals[ending]);
    return true;
  }

  #track(exchange: ProxyExchange): void {
    const { threadId } = exchange.target;
    const exchanges = this.#exchanges.get(threadId) ?? new Set();
    exchanges.add(exchange);
    this.#exchanges.set(threadId, exchanges);
    exchange.hold(() => {
      exchanges.delete(exchange);
      if (exchanges.size === 0 && this.#exchanges.get(threadId) === exchanges) {
        this.#exchanges.delete(threadId);
      }
    });
  }
}

/**
 * Whether the request came on a connection whose previous answer had not
 * ended (HTTP pipelining). Node hands such a request over at once but
 * gives its response the connection only once the one ahead finishes, and
 * never closes it if the connection closes first, so nothing could tell
 * when it ended. The pinned agent's HTTP client never pipelines (undici,
 * one request at a time per connection), so such a connection is ended
 * without relaying anything; the request ahead is ended with it.
 * https://github.com/nodejs/node/blob/v24.0.0/lib/_http_server.js (`parserOnIncoming`)
 */
function isPipelined(response: ServerResponse): boolean {
  return response.socket === null;
}
