import type { WebSocketServer } from "ws";
import type { Authenticator } from "../authentication/authenticator.js";
import type { DesktopFlowLimits } from "../desktop/desktop-splice.js";
import type { ThreadDesktops } from "../desktop/thread-desktops.js";
import type { Logger } from "../logger.js";
import type { ThreadRelayRegistry } from "../thread-relay/thread-relay-registry.js";
import type { ThreadStore } from "../threads/thread-store.js";
import type { SupervisorAuthorization } from "./supervisor-authorization.js";

/** What the WebSocket endpoints need to accept a connection and attach it to its thread. */
export type UpgradeDependencies = {
  /** Created with `noServer`, so the endpoints decide which upgrades it completes. */
  webSocketServer: WebSocketServer;
  relays: ThreadRelayRegistry;
  /** Consulted so that clients connect only to their own threads. */
  threadStore: ThreadStore;
  authorizeSupervisor: SupervisorAuthorization;
  /** Judges the access tokens clients authenticate with. */
  authenticator: Authenticator;
  /** How long a new client connection has to authenticate before it is closed. */
  clientAuthenticationTimeoutInMilliseconds: number;
  allowedClientOrigins: ReadonlySet<string>;
  /** Accept only upgrades addressed to loopback, as development mode must. */
  acceptOnlyLoopbackHosts: boolean;
  heartbeatIntervalInMilliseconds: number;
  desktop: DesktopEndpointDependencies;
  logger: Logger;
};

/** What the desktop viewer and desktop stream endpoints need besides. */
export type DesktopEndpointDependencies = {
  /**
   * The desktop's own, with a frame limit suited to VNC data rather than
   * to the JSON messages of the other endpoints.
   */
  webSocketServer: WebSocketServer;
  desktops: ThreadDesktops;
  /** Notes the user's input on a desktop they control, which keeps its sandbox awake. */
  recordUserDesktopInput: (threadId: string) => Promise<void>;
  flowLimits: DesktopFlowLimits;
};
