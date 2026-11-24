import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { parseClientEndpointPath } from "@barrack/protocol";
import { ClientSession } from "./client-session.js";
import { rejectUpgrade } from "./reject-upgrade.js";
import { limitBytesUntilAuthenticated } from "./unauthenticated-byte-limit.js";
import type { UpgradeDependencies } from "./upgrade-dependencies.js";

/**
 * Accepts a client's connection for `/threads/{threadId}/client`. Nothing
 * about the thread is checked here, not even that it exists, because the
 * client has not yet said who it is: browsers cannot put an access token on
 * a WebSocket upgrade, so it is the first message, and `ClientSession`
 * checks it and the thread's owner before sending anything.
 *
 * An `Origin` header, which browsers always send on upgrades and pages
 * cannot forge, must be one the installation serves its client from, so a
 * page on another site cannot even open the connection. Native apps send
 * none, and are let through to authenticate like everyone else.
 */
export function acceptClientUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  dependencies: UpgradeDependencies,
): void {
  const endpoint = parseClientEndpointPath(request.url ?? "");
  if (!endpoint.ok) {
    dependencies.logger.warn(
      { reason: endpoint.errorMessage },
      "Refused a client connection with a bad request",
    );
    rejectUpgrade(socket, 400, endpoint.errorMessage);
    return;
  }
  const logger = dependencies.logger.child({
    threadId: endpoint.value.threadId,
    peer: "client",
    connectionId: randomUUID(),
  });
  const origin = request.headers.origin;
  if (origin !== undefined && !dependencies.allowedClientOrigins.has(origin)) {
    logger.warn({ origin }, "Refused a client connection from an origin that is not allowed");
    rejectUpgrade(socket, 403, `Origin "${origin}" is not allowed to connect.`);
    return;
  }
  dependencies.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    const byteLimit = limitBytesUntilAuthenticated(socket, () =>
      logger.warn(
        "Dropped a client that sent more before authenticating than authenticating needs",
      ),
    );
    new ClientSession(webSocket, endpoint.value, dependencies, logger, byteLimit).start();
  });
}
