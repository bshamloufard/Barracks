import { createServer, type Server } from "node:http";
import { maximumFrameLength } from "@barrack/protocol";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer } from "ws";
import type { ControlPlaneConfiguration } from "./configuration.js";
import { createHttpApp } from "./http-app.js";
import type { Logger } from "./logger.js";
import { standardCloseCodes } from "./standard-close-codes.js";
import type { ThreadEventLog } from "./thread-event-log/thread-event-log.js";
import { ThreadRelayRegistry } from "./thread-relay/thread-relay-registry.js";
import { createUpgradeRouter } from "./websocket/route-upgrade.js";
import { authorizeWithSharedToken } from "./websocket/supervisor-authorization.js";

/**
 * Frames are limited in characters (UTF-16 code units), but WebSocket payloads
 * are measured in UTF-8 bytes, and one code unit takes at most three bytes.
 * Every frame within the character limit therefore fits; the exact character
 * count is checked when the frame is parsed.
 */
const maximumPayloadInBytes = 3 * maximumFrameLength;

/**
 * Often enough to notice a vanished peer within a minute, and comfortably
 * inside the idle timeouts of the proxies that sit in front of hosted
 * services.
 */
const defaultHeartbeatIntervalInMilliseconds = 30_000;

export type ControlPlaneServerOptions = {
  configuration: ControlPlaneConfiguration;
  threadEventLog: ThreadEventLog;
  logger: Logger;
  heartbeatIntervalInMilliseconds?: number;
};

export type RunningControlPlaneServer = {
  /** The port actually listened on, which differs from the configured one when that is 0. */
  port: number;
  /** Closes every WebSocket and stops listening; resolves once all connections have ended. */
  close(): Promise<void>;
};

/** One HTTP server on one port, serving the HTTP routes and both WebSocket endpoints. */
export async function startControlPlaneServer(
  options: ControlPlaneServerOptions,
): Promise<RunningControlPlaneServer> {
  const { configuration, logger } = options;
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: maximumPayloadInBytes,
  });
  const httpApp = createHttpApp(configuration.webClientDirectory);
  // Hono's adapter would otherwise replace the global Request and Response
  // classes with faster ones; nothing here needs that, so globals are left alone.
  const httpServer = createServer(
    getRequestListener(httpApp.fetch, { overrideGlobalObjects: false }),
  );
  httpServer.on(
    "upgrade",
    createUpgradeRouter({
      webSocketServer,
      relays: new ThreadRelayRegistry(options.threadEventLog, logger),
      authorizeSupervisor: authorizeWithSharedToken(configuration.supervisorToken),
      allowedClientOrigins: new Set(configuration.allowedClientOrigins),
      heartbeatIntervalInMilliseconds:
        options.heartbeatIntervalInMilliseconds ?? defaultHeartbeatIntervalInMilliseconds,
      logger,
    }),
  );
  const port = await listen(httpServer, configuration.host, configuration.port);
  logger.info({ host: configuration.host, port }, "Control plane listening");
  return {
    port,
    close: () => closeServer(httpServer, webSocketServer),
  };
}

function listen(httpServer: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      const address = httpServer.address();
      if (address === null || typeof address === "string") {
        reject(new Error(`Expected a TCP address after listening, got ${String(address)}`));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(httpServer: Server, webSocketServer: WebSocketServer): Promise<void> {
  // The server keeps counting upgraded sockets as its connections, so this
  // resolves only after every WebSocket below has finished closing.
  const closed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  for (const socket of webSocketServer.clients) {
    socket.close(standardCloseCodes.goingAway, "The control plane is shutting down");
  }
  return closed;
}
