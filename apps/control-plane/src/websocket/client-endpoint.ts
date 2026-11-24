import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  type ClientEndpointParameters,
  parseClientEndpointPath,
  parseClientToControlPlaneMessage,
} from "@barrack/protocol";
import type { WebSocket } from "ws";
import type { Logger } from "../logger.js";
import { standardCloseCodes } from "../standard-close-codes.js";
import { keepConnectionAlive } from "./heartbeat.js";
import { receiveMessages } from "./receive-messages.js";
import { rejectUpgrade } from "./reject-upgrade.js";
import type { UpgradeDependencies } from "./upgrade-dependencies.js";
import { WebSocketClientConnection } from "./web-socket-connections.js";

/**
 * Accepts a client's connection for `/threads/{threadId}/client`.
 *
 * Clients are not authenticated until Milestone 3. Checking `Origin` stops a
 * web page on another site from opening this connection from the user's
 * browser (browsers always send it on WebSocket upgrades and pages cannot
 * forge it). It does not stop other programs on the same machine, which is
 * why the control plane listens only on the loopback interface by default.
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
  if (origin === undefined || !dependencies.allowedClientOrigins.has(origin)) {
    logger.warn({ origin }, "Refused a client connection from an origin that is not allowed");
    rejectUpgrade(socket, 403, `Origin "${origin ?? ""}" is not allowed to connect.`);
    return;
  }
  dependencies.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    attachClient(webSocket, endpoint.value, dependencies, logger);
  });
}

function attachClient(
  webSocket: WebSocket,
  endpoint: ClientEndpointParameters,
  dependencies: UpgradeDependencies,
  logger: Logger,
): void {
  const relay = dependencies.relays.relayFor(endpoint.threadId);
  const connection = new WebSocketClientConnection(webSocket, logger);
  logger.info({ lastSeenSequence: endpoint.lastSeenSequence }, "Client connected");
  keepConnectionAlive(webSocket, dependencies.heartbeatIntervalInMilliseconds, logger);
  webSocket.on("error", (error) => logger.warn({ err: error }, "Client connection failed"));
  webSocket.on("close", (closeCode, reason) => {
    logger.info({ closeCode, reason: reason.toString() }, "Client disconnected");
    relay.detachClient(connection);
  });
  receiveMessages(
    webSocket,
    parseClientToControlPlaneMessage,
    (message) => relay.receiveFromClient(connection, message),
    logger,
  );
  relay.attachClient(connection, endpoint.lastSeenSequence).catch((error: unknown) => {
    logger.error({ err: error }, "Could not replay the thread's history to a client");
    webSocket.close(standardCloseCodes.internalError, "Could not replay the thread's history");
  });
}
