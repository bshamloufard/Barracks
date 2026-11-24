import {
  type ClientEndpointParameters,
  type ClientToControlPlaneMessage,
  closeCodes,
  parseClientToControlPlaneMessage,
} from "@barrack/protocol";
import type { WebSocket } from "ws";
import type { AuthenticatedUser } from "../authentication/authenticator.js";
import type { Logger } from "../logger.js";
import type { ThreadRelay } from "../thread-relay/thread-relay.js";
import type { ThreadAccess } from "../threads/thread-access.js";
import { ConnectionAuthentication } from "./connection-authentication.js";
import { keepConnectionAlive } from "./heartbeat.js";
import { receiveMessages } from "./receive-messages.js";
import {
  largestUnauthenticatedClientInputInBytes,
  type UnauthenticatedByteLimit,
} from "./unauthenticated-byte-limit.js";
import type { UpgradeDependencies } from "./upgrade-dependencies.js";
import { WebSocketClientConnection } from "./web-socket-connections.js";

/**
 * Where a client's connection is in its life:
 * - `awaiting_authentication`: open, and nothing about the thread sent yet;
 *   only an `authenticate` message is acceptable, within the time allowed.
 * - `authenticating`: that message is being checked, and then the thread's
 *   owner. The client must wait for the replay announcement.
 * - `attached`: the user owns the thread, and the client is attached to its
 *   relay, which replays history and then sends live traffic.
 */
type Phase =
  | { name: "awaiting_authentication" }
  | { name: "authenticating" }
  | {
      name: "attached";
      relay: ThreadRelay;
      connection: WebSocketClientConnection;
    };

/**
 * One client's connection to one thread, from the upgrade until it closes.
 * It is the only way a client reaches a thread's relay: it attaches only
 * after the client's access token is verified and `ThreadAccess.check`
 * confirms the user owns the thread (`ConnectionAuthentication`), so the
 * replay announcement is the first thing an authenticated client receives
 * and an unauthenticated one receives nothing at all. While attached, every
 * newer token must be for the same user, and when the newest expires
 * without a replacement the connection is closed with `accessTokenExpired`.
 */
export class ClientSession {
  readonly #webSocket: WebSocket;
  readonly #endpoint: ClientEndpointParameters;
  readonly #dependencies: UpgradeDependencies;
  readonly #logger: Logger;
  readonly #byteLimit: UnauthenticatedByteLimit;
  readonly #authentication: ConnectionAuthentication;
  #phase: Phase = { name: "awaiting_authentication" };
  #authenticationDeadline: ReturnType<typeof setTimeout> | undefined;

  constructor(
    webSocket: WebSocket,
    endpoint: ClientEndpointParameters,
    dependencies: UpgradeDependencies,
    logger: Logger,
    byteLimit: UnauthenticatedByteLimit,
  ) {
    this.#webSocket = webSocket;
    this.#endpoint = endpoint;
    this.#dependencies = dependencies;
    this.#logger = logger;
    this.#byteLimit = byteLimit;
    this.#authentication = new ConnectionAuthentication({
      authenticator: dependencies.authenticator,
      threadStore: dependencies.threadStore,
      logger,
      close: (closeCode, reason) => this.#close(closeCode, reason),
    });
  }

  start(): void {
    const { heartbeatIntervalInMilliseconds, clientAuthenticationTimeoutInMilliseconds } =
      this.#dependencies;
    this.#logger.info({ lastSeenSequence: this.#endpoint.lastSeenSequence }, "Client connected");
    keepConnectionAlive(this.#webSocket, heartbeatIntervalInMilliseconds, this.#logger);
    this.#authenticationDeadline = setTimeout(
      () => this.#close(closeCodes.authenticationTimedOut, "Did not authenticate in time"),
      clientAuthenticationTimeoutInMilliseconds,
    );
    this.#webSocket.on("error", (error) =>
      this.#logger.warn({ err: error }, "Client connection failed"),
    );
    this.#webSocket.on("close", (closeCode, reason) => this.#handleClose(closeCode, reason));
    receiveMessages(
      this.#webSocket,
      parseClientToControlPlaneMessage,
      (message) => this.#receive(message),
      this.#logger,
      { largestFrameInBytes: () => this.#largestFrameInBytes() },
    );
  }

  /** Until the client owns the thread, nothing larger than an `authenticate` message is parsed. */
  #largestFrameInBytes(): number {
    return this.#phase.name === "attached"
      ? Number.POSITIVE_INFINITY
      : largestUnauthenticatedClientInputInBytes;
  }

  #receive(message: ClientToControlPlaneMessage): void {
    const phase = this.#phase;
    if (phase.name === "awaiting_authentication" && message.type === "authenticate") {
      this.#phase = { name: "authenticating" };
      clearTimeout(this.#authenticationDeadline);
      void this.#authenticateAndAttach(message.accessToken);
      return;
    }
    if (phase.name !== "attached") {
      this.#close(closeCodes.notAuthenticated, "Authenticate first, then wait for the replay");
      return;
    }
    if (message.type === "authenticate") {
      this.#authentication.acceptRefreshedToken(message.accessToken);
      return;
    }
    phase.relay.receiveFromClient(phase.connection, message);
  }

  async #authenticateAndAttach(accessToken: string): Promise<void> {
    const owner = await this.#authentication.authenticateOwner(
      accessToken,
      this.#endpoint.threadId,
    );
    if (owner !== undefined) {
      this.#attach(owner.access, owner.user);
    }
  }

  #attach(access: ThreadAccess, user: AuthenticatedUser): void {
    if (this.#webSocket.readyState !== this.#webSocket.OPEN) {
      this.#logger.info("A client went away while it was being authenticated");
      return;
    }
    const connection = new WebSocketClientConnection(this.#webSocket, this.#logger);
    const relay = this.#dependencies.relays.attachClient(
      access,
      connection,
      this.#endpoint.lastSeenSequence,
    );
    this.#phase = { name: "attached", relay, connection };
    this.#byteLimit.lift();
    this.#logger.info({ userId: user.userId }, "Client authenticated and attached");
  }

  /** Close reasons must fit in 123 bytes, so they stay short. */
  #close(closeCode: number, reason: string): void {
    this.#logger.info({ closeCode, reason }, "Closing a client connection");
    this.#webSocket.close(closeCode, reason);
  }

  #handleClose(closeCode: number, reason: Buffer): void {
    clearTimeout(this.#authenticationDeadline);
    this.#authentication.dispose();
    this.#logger.info({ closeCode, reason: reason.toString() }, "Client disconnected");
    if (this.#phase.name === "attached") {
      this.#phase.relay.detachClient(this.#phase.connection);
    }
  }
}
