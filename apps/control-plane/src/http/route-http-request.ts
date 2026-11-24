import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { isModelProxyRequestTarget } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import { forbiddenHostExplanation, isAddressedToLoopback } from "../loopback-host.js";

export type HttpRequestRouting = {
  /** The HTTP app: the API, the bundle upload, `/health` and the web client. */
  app: RequestListener;
  modelProxy: { handle(request: IncomingMessage, response: ServerResponse): Promise<void> };
  /** Development mode answers only requests addressed to loopback, the model proxy's included. */
  acceptOnlyLoopbackHosts: boolean;
  logger: Logger;
};

/**
 * Hands each plain HTTP request to the model proxy or to the HTTP app. The
 * proxy works on Node's own request and response, so that each streams
 * with backpressure in both directions, which the app's web-standard
 * bodies do not give as directly. It is the one path the app does not see,
 * so the development mode's `Host` check is applied here too, as the app
 * applies it to everything else. The proxy authenticates each request by
 * the thread's proxy token itself; no user's token is involved.
 */
export function routeHttpRequest(routing: HttpRequestRouting): RequestListener {
  return (request, response) => {
    if (!isModelProxyRequestTarget(request.url ?? "")) {
      routing.app(request, response);
      return;
    }
    if (routing.acceptOnlyLoopbackHosts && !isAddressedToLoopback(request.headers.host)) {
      response.writeHead(403, { "content-type": "text/plain", connection: "close" });
      response.end(forbiddenHostExplanation);
      return;
    }
    routing.modelProxy.handle(request, response).catch((error: unknown) => {
      routing.logger.error({ err: error }, "The model proxy failed to handle a request");
      if (!response.headersSent) {
        response.writeHead(500, { connection: "close" });
      }
      response.destroy();
    });
  };
}
