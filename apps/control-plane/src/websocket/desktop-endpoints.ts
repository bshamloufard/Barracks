import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { parseDesktopStreamEndpointPath, parseDesktopViewerEndpointPath } from "@barrack/protocol";
import { DesktopViewerSession } from "./desktop-viewer-session.js";
import { keepConnectionAlive } from "./heartbeat.js";
import { rejectUpgrade } from "./reject-upgrade.js";
import { limitBytesUntilAuthenticated } from "./unauthenticated-byte-limit.js";
import type { UpgradeDependencies } from "./upgrade-dependencies.js";

/**
 * Accepts a viewer's connection for `/threads/{threadId}/desktop`, under
 * the same rules as a thread's client connection (see `client-endpoint.ts`):
 * an `Origin`, when sent, must be allowed, and nothing about the thread is
 * checked until the viewer's first message has said who it is.
 */
export function acceptDesktopViewerUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  dependencies: UpgradeDependencies,
): void {
  const endpoint = parseDesktopViewerEndpointPath(request.url ?? "");
  if (!endpoint.ok) {
    dependencies.logger.warn(
      { reason: endpoint.errorMessage },
      "Refused a desktop viewer with a bad request",
    );
    rejectUpgrade(socket, 400, endpoint.errorMessage);
    return;
  }
  const logger = dependencies.logger.child({
    threadId: endpoint.value.threadId,
    peer: "desktop-viewer",
    connectionId: randomUUID(),
  });
  const origin = request.headers.origin;
  if (origin !== undefined && !dependencies.allowedClientOrigins.has(origin)) {
    logger.warn({ origin }, "Refused a desktop viewer from an origin that is not allowed");
    rejectUpgrade(socket, 403, `Origin "${origin}" is not allowed to connect.`);
    return;
  }
  dependencies.desktop.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    const byteLimit = limitBytesUntilAuthenticated(socket, () =>
      logger.warn("Dropped a desktop viewer that sent more before authenticating than it needs"),
    );
    new DesktopViewerSession(webSocket, endpoint.value, dependencies, logger, byteLimit).start();
  });
}

const refusedStreamExplanation =
  "Missing or wrong supervisor credentials, or a desktop stream that was not asked for.";

/**
 * Accepts a supervisor's desktop stream for
 * `/threads/{threadId}/desktop-streams/{streamId}`: only one this control
 * plane asked that thread's supervisor for and still waits for, and only
 * with that thread's token. Either failing is answered the same, so the
 * answer does not say which. The stream arrives paused: nothing it sends
 * is read until the viewer has been told the desktop is ready.
 */
export async function acceptDesktopStreamUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  dependencies: UpgradeDependencies,
): Promise<void> {
  const endpoint = parseDesktopStreamEndpointPath(request.url ?? "");
  if (!endpoint.ok) {
    dependencies.logger.warn(
      { reason: endpoint.errorMessage },
      "Refused a desktop stream with a bad request",
    );
    rejectUpgrade(socket, 400, endpoint.errorMessage);
    return;
  }
  const { threadId, streamId } = endpoint.value;
  const logger = dependencies.logger.child({ threadId, peer: "desktop-stream", streamId });
  const { streamRequests } = dependencies.desktop.desktops;
  let isAuthorized: boolean;
  try {
    isAuthorized =
      streamRequests.isAwaited(threadId, streamId) &&
      (await dependencies.authorizeSupervisor({
        threadId,
        authorizationHeader: request.headers.authorization,
      }));
  } catch (error) {
    logger.error({ err: error }, "Could not check a desktop stream's credentials");
    rejectUpgrade(socket, 503, "The control plane cannot check credentials now; try again later.");
    return;
  }
  if (!isAuthorized || socket.destroyed) {
    logger.warn("Refused a desktop stream");
    rejectUpgrade(socket, 401, refusedStreamExplanation, { "WWW-Authenticate": "Bearer" });
    return;
  }
  dependencies.desktop.webSocketServer.handleUpgrade(request, socket, head, (streamSocket) => {
    streamSocket.pause();
    streamSocket.on("error", (error) => logger.warn({ err: error }, "A desktop stream failed"));
    keepConnectionAlive(streamSocket, dependencies.heartbeatIntervalInMilliseconds, logger);
    if (!streamRequests.deliver(threadId, streamId, streamSocket)) {
      logger.warn("A desktop stream arrived after its viewer stopped waiting");
      streamSocket.terminate();
    }
  });
}
