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
  /** Whether the whole request reached the provider, which may then bill it whatever follows. */
  wasRequestSent: boolean;
  responseBytes: number;
  /** What the answer said it used; undefined if there was no answer to read. */
  usage: MeteredUsage | undefined;
};

export type RelayInterruption =
  | "agent_went_away"
  | "response_too_large"
  | "timed_out"
  | "upstream_failed"
  | "cancelled"
  | "shutting_down";

export type RelayRequestOptions = {
  request: IncomingMessage;
  response: ServerResponse;
  route: RelayedRoute;
  /** The request's body, read whole and checked (see `request-body.ts`). */
  body: Buffer;
  ownerKey: string;
  limits: ModelProxyLimits;
  /** Aborting it ends the request at once, wherever it is (the thread stopped, say). */
  cancellation: AbortSignal;
};

/**
 * Forwards one admitted request, its body already read, to the provider and
 * streams the answer back.
 *
 * The answer goes through Node's stream pipeline, so the provider is read
 * only as fast as the agent takes it: an agent that stops reading stops the
 * provider being read until the idle limit ends the request. Nothing of the
 * answer is buffered beyond the streams' own high-water marks. Node's
 * client never follows a redirect, and a redirect answer is refused rather
 * than passed on, so a request never leaves the provider's own address.
 * Whichever side gives up first, the other is ended too: the agent hanging
 * up ends the request to the provider, which for a streamed answer
 * normally stops it generating (no provider promises that; see
 * `answer-usage.ts` for how what it may have generated is counted).
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
  #responseBody: ByteCounter | undefined;
  #upstreamStatus: number | undefined;
  #meter: UsageMeter | undefined;
  #interruption: RelayInterruption | undefined;
  #firstByteTimer: NodeJS.Timeout | undefined;
  #totalTimer: NodeJS.Timeout | undefined;
  #isFinished = false;
  #isRequestSent = false;

  constructor(options: RelayRequestOptions, resolve: (outcome: RelayOutcome) => void) {
    this.#options = options;
    this.#resolve = resolve;
  }

  start(): void {
    const { request, response, route, body, ownerKey, limits, cancellation } = this.#options;
    if (cancellation.aborted || response.destroyed) {
      // Ended, or hung up, before anything was sent: nothing reaches the provider.
      this.#interruption = interruptionFor(cancellation.reason);
      this.#finish();
      return;
    }
    const client = route.upstreamUrl.protocol === "https:" ? https : http;
    const upstreamRequest = client.request(route.upstreamUrl, {
      method: "POST",
      headers: {
        ...buildUpstreamHeaders(route.format, request.headers, ownerKey),
        "content-length": body.length,
      },
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
    const cancel = () => this.#interrupt(interruptionFor(cancellation.reason));
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
    upstreamRequest.end(body, () => {
      this.#isRequestSent = true;
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

  /**
   * The first reason wins; everything still open is ended, and the relay
   * finishes at once, without waiting for the agent's response to close:
   * it may have closed already (it closes only once), and one that Node
   * queued behind another on the same connection never closes at all.
   */
  #interrupt(reason: RelayInterruption): void {
    if (this.#isFinished) {
      return;
    }
    this.#interruption ??= reason;
    this.#abortController.abort();
    const { response, route } = this.#options;
    if (response.headersSent) {
      response.destroy();
    } else {
      sendRefusal(response, route.format, refusalFor(this.#interruption));
    }
    this.#finish();
  }

  #finish(): void {
    if (this.#isFinished) {
      return;
    }
    this.#isFinished = true;
    // A request answered and sent in full keeps its connection for the next;
    // one the provider answered before reading it all is ended here.
    if (!this.#isRequestSent) {
      this.#abortController.abort();
    }
    clearTimeout(this.#firstByteTimer);
    clearTimeout(this.#totalTimer);
    this.#resolve({
      upstreamStatus: this.#upstreamStatus,
      interruption: this.#interruption,
      wasRequestSent: this.#isRequestSent,
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

/** A request ended through its cancellation: by the agent hanging up, or by the proxy. */
function interruptionFor(cancellationReason: unknown): RelayInterruption {
  switch (cancellationReason) {
    case "agent_went_away":
    case "shutting_down":
      return cancellationReason;
    default:
      return "cancelled";
  }
}

function refusalFor(interruption: RelayInterruption): ProxyRefusal {
  switch (interruption) {
    case "timed_out":
      return proxyRefusals.upstreamTooSlow;
    case "cancelled":
      return proxyRefusals.tokenRefused;
    case "shutting_down":
      return proxyRefusals.proxyBusy;
    case "upstream_failed":
    case "response_too_large":
    case "agent_went_away":
      return proxyRefusals.upstreamUnreachable;
  }
}
