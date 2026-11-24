import type { WebSocketServer } from "ws";
import type { Logger } from "../logger.js";
import type { ThreadRelayRegistry } from "../thread-relay/thread-relay-registry.js";
import type { SupervisorAuthorization } from "./supervisor-authorization.js";

/** What the WebSocket endpoints need to accept a connection and attach it to its thread. */
export type UpgradeDependencies = {
  /** Created with `noServer`, so the endpoints decide which upgrades it completes. */
  webSocketServer: WebSocketServer;
  relays: ThreadRelayRegistry;
  authorizeSupervisor: SupervisorAuthorization;
  allowedClientOrigins: ReadonlySet<string>;
  heartbeatIntervalInMilliseconds: number;
  logger: Logger;
};
