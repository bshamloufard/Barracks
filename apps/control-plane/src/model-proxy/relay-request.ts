import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { ByteCounter, ByteLimitExceededError } from "./byte-counter.js";
import type { ModelProxyLimits } from "./model-proxy-limits.js";
import { buildDownstreamHeaders, buildUpstreamHeaders } from "./proxy-headers.js";
import { type ProxyRefusal, proxyRefusals, sendRefusal } from "./proxy-refusals.js";
import type { RelayedRoute } from "./relayed-routes.js";
import { SecretRedaction } from "./secret-redaction.js";
import { type MeteredUsage, UsageMeter } from "./usage-meter.js";

/** How one relayed request ended, for the log and for counting its usage. */
export type RelayOutcome = {
  /** The provider's status, or undefined if it never answered. */
  upstreamStatus: number | undefined;
  /** Why the request ended early, if it did. */
  interruption: RelayInterruption | undefined;
  requestBytes: number;
  responseBytes: number;
  /** What the answer said it used; undefined if there was no answer to read. */
  usage: MeteredUsage | undefined;
};

export type RelayInterruption =
  | "agent_went_away"
  | "request_too_large"
  | "response_too_large"
  | "timed_out"
  | "upstream_failed"
  | "cancelled";

export type RelayRequestOptions = {
  request: IncomingMessage;
  response: ServerResponse;
  route: RelayedRoute;
  ownerKey: string;
  limits: ModelProxyLimits;
  /** Aborting it ends the request at once, wherever it is (the thread stopped, say). */
  cancellation: AbortSignal;
};

/**
 * Forwards one admitted request to the provider and streams the answer back.
 *
 * Both directions go through Node's stream pipelines, so each side is read
 * only as fast as the other takes it: a slow provider slows the agent's
 * upload, and an agent that stops reading stops the provider being read
 * until the idle limit ends the request. Nothing is buffered beyond the
 * streams' own high-water marks. Node's client never follows a redirect,
 * and a redirect answer is refused rather than passed on, so a request
 * never leaves the provider's own address. Whichever side gives up first,
 * the other is ended too: the agent hanging up cancels the provider's
 * request, which stops it generating.
 */
export function relayRequest(options: RelayRequestOptions): Promise<RelayOutcome> {
  return new Promise((resolve) => {
    new RequestRelay(options, resolve).start();
  });
}

class RequestRelay {
  readonly #options: RelayRequestOptions;
  readonly #resolve: (outcome: RelayOutcome) => void;
  readonly #abortController = new AbortController();
  readonly #requestBody: ByteCounter;
  #responseBody: ByteCounter | undefined;
  #upstreamStatus: number | undefined;
  #meter: UsageMeter | undefined;
  #interruption: RelayInterruption | undefined;
  #firstByteTimer: NodeJS.Timeout | undefined;
  #totalTimer: NodeJS.Timeout | undefined;
  #isFinished = false;

  constructor(options: RelayRequestOptions, resolve: (outcome: RelayOutcome) => void) {
    this.#options = options;
    this.#resolve = resolve;
    this.#requestBody = new ByteCounter(options.limits.maximumRequestBytes);
  }

  start(): void {
    const { request, response, route, ownerKey, limits, cancellation } = this.#options;
    const client = route.upstreamUrl.protocol === "https:" ? https : http;
    const upstreamRequest = client.request(route.upstreamUrl, {
      method: "POST",
      headers: buildUpstreamHeaders(route.format, request.headers, ownerKey),
      signal: this.#abortController.signal,
    });
    upstreamRequest.setTimeout(limits.idleTimeoutInMilliseconds, () =>
      this.#interrupt("timed_out"),
    );
    response.setTimeout(limits.idleTimeoutInMilliseconds, () => this.#interrupt("timed_out"));
    this.#firstByteTimer = setTimeout(
      () => this.#interrupt("timed_out"),
      limits.firstByteTimeoutInMilliseconds,
    );
    this.#totalTimer = setTimeout(
      () => this.#interrupt("timed_out"),
      limits.totalTimeoutInMilliseconds,
    );
    const cancel = () => this.#interrupt("cancelled");
    cancellation.addEventListener("abort", cancel, { once: true });
    response.on("close", () => {
      cancellation.removeEventListener("abort", cancel);
      if (!response.writableFinished) {
        this.#interrupt("agent_went_away");
      }
      this.#finish();
    });
    upstreamRequest.on("response", (upstreamResponse) => this.#relayAnswer(upstreamResponse));
    upstreamRequest.on("error", () => this.#interrupt("upstream_failed"));
    pipeline(request, this.#requestBody, upstreamRequest).catch((error: unknown) => {
      this.#interrupt(
        error instanceof ByteLimitExceededError ? "request_too_large" : "agent_went_away",
      );
    });
  }

  #relayAnswer(upstreamResponse: IncomingMessage): void {
    const { response, route, ownerKey, limits } = this.#options;
    clearTimeout(this.#firstByteTimer);
    const status = upstreamResponse.statusCode ?? 502;
    this.#upstreamStatus = status;
    const decompression = createDecompression(upstreamResponse.headers["content-encoding"]);
    if ((status >= 300 && status < 400) || decompression === "unsupported") {
      upstreamResponse.resume();
      this.#interrupt("upstream_failed");
      return;
    }
    const meter = new UsageMeter(route.format, upstreamResponse.headers["content-type"]);
    this.#meter = meter;
    this.#responseBody = new ByteCounter(limits.maximumResponseBytes, (chunk) =>
      meter.write(chunk),
    );
    response.writeHead(status, buildDownstreamHeaders(upstreamResponse.headers, ownerKey));
    const stages: Array<NodeJS.ReadableStream | Transform | ServerResponse> = [
      upstreamResponse,
      ...(decompression === undefined ? [] : [decompression]),
      this.#responseBody,
      new SecretRedaction(ownerKey),
      response,
    ];
    pipeline(stages).catch((error: unknown) => {
      this.#interrupt(
        error instanceof ByteLimitExceededError ? "response_too_large" : "upstream_failed",
      );
    });
  }

  /** The first reason wins; everything still open is ended. */
  #interrupt(reason: RelayInterruption): void {
    if (this.#isFinished) {
      return;
    }
    this.#interruption ??= reason;
    this.#abortController.abort();
    const { response, route } = this.#options;
    if (!response.headersSent) {
      sendRefusal(response, route.format, refusalFor(this.#interruption));
      return;
    }
    response.destroy();
  }

  #finish(): void {
    if (this.#isFinished) {
      return;
    }
    this.#isFinished = true;
    this.#abortController.abort();
    clearTimeout(this.#firstByteTimer);
    clearTimeout(this.#totalTimer);
    this.#resolve({
      upstreamStatus: this.#upstreamStatus,
      interruption: this.#interruption,
      requestBytes: this.#requestBody.count,
      responseBytes: this.#responseBody?.count ?? 0,
      usage: this.#meter?.finish(),
    });
  }
}

/**
 * The proxy asks for an uncompressed answer; one compressed all the same is
 * decompressed here, before it is counted, so the size limit holds for what
 * it expands to.
 */
function createDecompression(
  contentEncoding: string | undefined,
): Transform | undefined | "unsupported" {
  switch (contentEncoding?.trim().toLowerCase()) {
    case undefined:
    case "":
    case "identity":
      return undefined;
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      return "unsupported";
  }
}

function refusalFor(interruption: RelayInterruption): ProxyRefusal {
  switch (interruption) {
    case "request_too_large":
      return proxyRefusals.requestTooLarge;
    case "timed_out":
      return proxyRefusals.upstreamTooSlow;
    case "cancelled":
      return proxyRefusals.tokenRefused;
    case "upstream_failed":
    case "response_too_large":
    case "agent_went_away":
      return proxyRefusals.upstreamUnreachable;
  }
}
