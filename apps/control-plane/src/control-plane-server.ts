import { createServer, type Server } from "node:http";
import { type ClientAuthenticationConfiguration, maximumFrameLength } from "@barrack/protocol";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer } from "ws";
import type { Authenticator } from "./authentication/authenticator.js";
import type { ControlPlaneConfiguration } from "./configuration.js";
import { type DesktopFlowLimits, defaultDesktopFlowLimits } from "./desktop/desktop-splice.js";
import type { ThreadDesktops } from "./desktop/thread-desktops.js";
import { createHttpApp } from "./http/http-app.js";
import { routeHttpRequest } from "./http/route-http-request.js";
import type { ThreadModelAccessDependencies } from "./http/threads-routes.js";
import type { Logger } from "./logger.js";
import type { ModelProxy } from "./model-proxy/model-proxy.js";
import type { ModelUsage } from "./model-usage/model-usage.js";
import type { ThreadPublisher } from "./publication/thread-publisher.js";
import type { RepositoryServices } from "./repositories/assemble-repository-services.js";
import type { SandboxLifecycle } from "./sandbox-lifecycle/sandbox-lifecycle.js";
import { standardCloseCodes } from "./standard-close-codes.js";
import type { ThreadEventLog } from "./thread-event-log/thread-event-log.js";
import type { ThreadRelayRegistry } from "./thread-relay/thread-relay-registry.js";
import type { ThreadStore } from "./threads/thread-store.js";
import { createUpgradeRouter } from "./websocket/route-upgrade.js";
import { authorizeWithThreadTokens } from "./websocket/supervisor-authorization.js";

/**
 * Frames are limited in characters (UTF-16 code units), but WebSocket payloads
 * are measured in UTF-8 bytes, and one code unit takes at most three bytes.
 * Every frame within the character limit therefore fits; the exact character
 * count is checked when the frame is parsed.
 */
const maximumPayloadInBytes = 3 * maximumFrameLength;

/**
 * A desktop frame is a piece of VNC data: what the supervisor read from the
 * VNC server at once (at most 64 KiB), or one of a viewer's VNC messages,
 * the largest a clipboard paste, which the viewer filter limits further.
 */
const maximumDesktopPayloadInBytes = 1024 * 1024;

/**
 * Often enough to notice a vanished peer within a minute, and comfortably
 * inside the idle timeouts of the proxies that sit in front of hosted
 * services.
 */
const defaultHeartbeatIntervalInMilliseconds = 30_000;

/**
 * Plenty for a client to send one message after the upgrade, while keeping
 * connections that never authenticate from lingering.
 */
const defaultClientAuthenticationTimeoutInMilliseconds = 5_000;

export type ControlPlaneServerOptions = {
  configuration: Pick<
    ControlPlaneConfiguration,
    "host" | "port" | "allowedClientOrigins" | "webClientDirectory"
  >;
  threadEventLog: ThreadEventLog;
  threadStore: ThreadStore;
  relays: ThreadRelayRegistry;
  desktops: ThreadDesktops;
  sandboxLifecycle: SandboxLifecycle;
  repositoryServices: RepositoryServices;
  modelAccess: ThreadModelAccessDependencies;
  modelProxy: ModelProxy;
  modelUsage: ModelUsage;
  publisher: ThreadPublisher;
  authenticator: Authenticator;
  /** What clients are told about signing in. */
  clientAuthentication: ClientAuthenticationConfiguration;
  logger: Logger;
  heartbeatIntervalInMilliseconds?: number;
  clientAuthenticationTimeoutInMilliseconds?: number;
  desktopFlowLimits?: DesktopFlowLimits;
};

export type RunningControlPlaneServer = {
  /** The port actually listened on, which differs from the configured one when that is 0. */
  port: number;
  /** Closes every WebSocket and stops listening; resolves once all connections have ended. */
  close(): Promise<void>;
};

/** One HTTP server on one port, serving the HTTP routes, the model proxy and the WebSocket endpoints. */
export async function startControlPlaneServer(
  options: ControlPlaneServerOptions,
): Promise<RunningControlPlaneServer> {
  const { configuration, threadStore, logger } = options;
  const allowedClientOrigins = new Set(configuration.allowedClientOrigins);
  // Taken from the authentication in effect, not configured separately, so
  // no caller can run development mode without it.
  const acceptOnlyLoopbackHosts = options.clientAuthentication.method === "development-single-user";
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: maximumPayloadInBytes,
  });
  const desktopWebSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: maximumDesktopPayloadInBytes,
    // VNC data is compressed already.
    perMessageDeflate: false,
  });
  const authorizeSupervisor = authorizeWithThreadTokens(threadStore);
  const { repositoryServices } = options;
  const httpApp = createHttpApp({
    authenticator: options.authenticator,
    clientAuthentication: options.clientAuthentication,
    allowedClientOrigins,
    threads: {
      threadStore,
      threadEventLog: options.threadEventLog,
      sandboxLifecycle: options.sandboxLifecycle,
      repositories: {
        requests: repositoryServices.requests,
        store: repositoryServices.repositories,
        isGithubAvailable: repositoryServices.githubConnections.isAvailable,
      },
      modelAccess: options.modelAccess,
      logger,
    },
    github: { githubConnections: repositoryServices.githubConnections, logger },
    publication: {
      publisher: options.publisher,
      uploads: repositoryServices.uploads,
      authorizeSupervisor,
      logger,
    },
    modelUsage: { usage: options.modelUsage, threadStore, logger },
    webClientDirectory: configuration.webClientDirectory,
    acceptOnlyLoopbackHosts,
  });
  // Hono's adapter would otherwise replace the global Request and Response
  // classes with faster ones; nothing here needs that, so globals are left alone.
  const httpServer = createServer(
    routeHttpRequest({
      app: getRequestListener(httpApp.fetch, { overrideGlobalObjects: false }),
      modelProxy: options.modelProxy,
      acceptOnlyLoopbackHosts,
      logger,
    }),
  );
  httpServer.on(
    "upgrade",
    createUpgradeRouter({
      webSocketServer,
      relays: options.relays,
      threadStore,
      authorizeSupervisor,
      authenticator: options.authenticator,
      clientAuthenticationTimeoutInMilliseconds:
        options.clientAuthenticationTimeoutInMilliseconds ??
        defaultClientAuthenticationTimeoutInMilliseconds,
      allowedClientOrigins,
      acceptOnlyLoopbackHosts,
      heartbeatIntervalInMilliseconds:
        options.heartbeatIntervalInMilliseconds ?? defaultHeartbeatIntervalInMilliseconds,
      desktop: {
        webSocketServer: desktopWebSocketServer,
        desktops: options.desktops,
        recordUserDesktopInput: (threadId) =>
          options.sandboxLifecycle.recordUserDesktopInput(threadId),
        flowLimits: options.desktopFlowLimits ?? defaultDesktopFlowLimits,
      },
      logger,
    }),
  );
  const port = await listen(httpServer, configuration.host, configuration.port);
  logger.info({ host: configuration.host, port }, "Control plane listening");
  return {
    port,
    close: () => closeServer(httpServer, [webSocketServer, desktopWebSocketServer]),
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

function closeServer(httpServer: Server, webSocketServers: WebSocketServer[]): Promise<void> {
  // The server keeps counting upgraded sockets as its connections, so this
  // resolves only after every WebSocket below has finished closing.
  const closed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  for (const socket of webSocketServers.flatMap((server) => [...server.clients])) {
    socket.close(standardCloseCodes.goingAway, "The control plane is shutting down");
  }
  return closed;
}
