import type { IncomingMessage, ServerResponse } from "node:http";
import type { ModelProxyRequestTarget } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { RelayedRoute } from "./relayed-routes.js";

/**
 * Why a request was ended before it could finish:
 * - `agent_went_away`: the agent hung up;
 * - `thread_ended`: its sandbox began stopping, or the thread is being deleted, on this instance;
 * - `no_longer_authorized`: a check of the records while it lasted refused it;
 * - `shutting_down`: this control plane is shutting down.
 */
export type ExchangeEnding =
  | "agent_went_away"
  | "thread_ended"
  | "no_longer_authorized"
  | "shutting_down";

/**
 * One request on its way through the proxy, from its arrival to its end,
 * and everything it holds meanwhile: whatever it takes (an admission, a
 * share of the bytes held, a timer) it hands to `hold`, and `close`, which
 * the proxy calls once whatever happened, gives all of it back.
 *
 * The agent hanging up is noticed from the moment the exchange exists,
 * before anything is awaited: it aborts `signal`, which every wait that can
 * be cut short listens to (reading the body, the request to the provider),
 * and which the proxy checks after every wait that cannot.
 */
export class ProxyExchange {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly target: ModelProxyRequestTarget;
  readonly route: RelayedRoute;
  readonly logger: Logger;
  readonly #cancellation = new AbortController();
  readonly #releases: Array<() => void> = [];
  #isClosed = false;

  constructor(fields: {
    request: IncomingMessage;
    response: ServerResponse;
    target: ModelProxyRequestTarget;
    route: RelayedRoute;
    logger: Logger;
  }) {
    this.request = fields.request;
    this.response = fields.response;
    this.target = fields.target;
    this.route = fields.route;
    this.logger = fields.logger;
    const noticeHangUp = () => {
      if (!this.response.writableFinished) {
        this.end("agent_went_away");
      }
    };
    this.response.once("close", noticeHangUp);
    this.hold(() => this.response.removeListener("close", noticeHangUp));
    if (this.response.destroyed || this.request.destroyed) {
      this.end("agent_went_away");
    }
  }

  /** Aborted once the request is ended, with its `ExchangeEnding` as the reason. */
  get signal(): AbortSignal {
    return this.#cancellation.signal;
  }

  /** Why the request was ended, if it was. */
  get ending(): ExchangeEnding | undefined {
    return this.signal.aborted ? (this.signal.reason as ExchangeEnding) : undefined;
  }

  /** Ends the request wherever it is; the first reason given is kept. */
  end(reason: ExchangeEnding): void {
    if (!this.signal.aborted) {
      this.#cancellation.abort(reason);
    }
  }

  /** Gives `release` back when the exchange closes, or at once if it already has. */
  hold(release: () => void): void {
    if (this.#isClosed) {
      release();
      return;
    }
    this.#releases.push(release);
  }

  /** Gives back everything held, newest first. Only the first call does anything. */
  close(): void {
    if (this.#isClosed) {
      return;
    }
    this.#isClosed = true;
    for (const release of this.#releases.reverse()) {
      release();
    }
    this.#releases.length = 0;
  }
}
