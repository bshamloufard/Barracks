import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  parseSupervisorEndpointPath,
  parseSupervisorToControlPlaneMessage,
} from "@barrack/protocol";
import type { WebSocket } from "ws";
import type { Logger } from "../logger.js";
import { keepConnectionAlive } from "./heartbeat.js";
import { receiveMessages } from "./receive-messages.js";
import { rejectUpgrade } from "./reject-upgrade.js";
import type { UpgradeDependencies } from "./upgrade-dependencies.js";
import { WebSocketSupervisorConnection } from "./web-socket-connections.js";

/**
 * Accepts a sandbox supervisor's connection for `/threads/{threadId}/supervisor`,
 * if it presents that thread's token.
 */
export async function acceptSupervisorUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  dependencies: UpgradeDependencies,
): Promise<void> {
  const endpoint = parseSupervisorEndpointPath(request.url ?? "");
  if (!endpoint.ok) {
    dependencies.logger.warn(
      { reason: endpoint.errorMessage },
      "Refused a supervisor connection with a bad request",
    );
    rejectUpgrade(socket, 400, endpoint.errorMessage);
    return;
  }
  const { threadId } = endpoint.value;
  const logger = dependencies.logger.child({
    threadId,
    peer: "supervisor",
    connectionId: randomUUID(),
  });
  let isAuthorized: boolean;
  try {
    isAuthorized = await dependencies.authorizeSupervisor({
      threadId,
      authorizationHeader: request.headers.authorization,
    });
  } catch (error) {
    logger.error({ err: error }, "Could not check a supervisor's credentials");
    rejectUpgrade(socket, 503, "The control plane cannot check credentials now; try again later.");
    return;
  }
  if (socket.destroyed) {
    logger.info("A supervisor went away while its credentials were being checked");
    return;
  }
  if (!isAuthorized) {
    logger.warn("Refused a supervisor connection with missing or wrong credentials");
    rejectUpgrade(socket, 401, "Missing or wrong supervisor credentials.", {
      "WWW-Authenticate": "Bearer",
    });
    return;
  }
  dependencies.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    attachSupervisor(webSocket, threadId, dependencies, logger);
  });
}

function attachSupervisor(
  webSocket: WebSocket,
  threadId: string,
  dependencies: UpgradeDependencies,
  logger: Logger,
): void {
  const connection = new WebSocketSupervisorConnection(webSocket, logger);
  logger.info("Supervisor connected");
  keepConnectionAlive(webSocket, dependencies.heartbeatIntervalInMilliseconds, logger);
  webSocket.on("error", (error) => logger.warn({ err: error }, "Supervisor connection failed"));
  const relay = dependencies.relays.attachSupervisor(threadId, connection);
  webSocket.on("close", (closeCode, reason) => {
    logger.info({ closeCode, reason: reason.toString() }, "Supervisor disconnected");
    relay.detachSupervisor(connection);
  });
  receiveMessages(
    webSocket,
    parseSupervisorToControlPlaneMessage,
    (message) => relay.receiveFromSupervisor(connection, message),
    logger,
  );
}
