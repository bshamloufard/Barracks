import type { IncomingMessage } from "node:http";
import {
  buildSupervisorEndpointPath,
  type ControlPlaneToSupervisorMessage,
  closeCodes,
  parseControlPlaneToSupervisorMessage,
  type SupervisorToControlPlaneMessage,
} from "@barrack/protocol";
import WebSocket, { type RawData } from "ws";
import type { Logger } from "../logger.js";
import { AgentEventBacklog } from "./agent-event-backlog.js";
import { computeReconnectDelay, type ReconnectDelaySettings } from "./reconnect-delay.js";

export type ConnectionTiming = ReconnectDelaySettings & {
  /** How often the supervisor pings the control plane. */
  heartbeatIntervalInMilliseconds: number;
  /** Silence from the control plane longer than this means the connection is dead. */
  heartbeatTimeoutInMilliseconds: number;
  /** Agent events kept during an outage, in characters of serialized frames. */
  backlogMaximumLength: number;
};

export const defaultConnectionTiming: ConnectionTiming = {
  initialDelayInMilliseconds: 500,
  maximumDelayInMilliseconds: 15_000,
  heartbeatIntervalInMilliseconds: 15_000,
  heartbeatTimeoutInMilliseconds: 35_000,
  // Tool output, the largest event, is capped at 64 Ki characters, so this
  // holds at least 512 of them: far more than an agent produces while a
  // control plane restarts, and about 64 MB of memory at most.
  backlogMaximumLength: 32 * 1024 * 1024,
};

export type ControlPlaneConnectionSettings = {
  /** For example `ws://127.0.0.1:8787`, without a trailing slash. */
  controlPlaneUrl: string;
  threadId: string;
  supervisorToken: string;
  logger: Logger;
  onMessage: (message: ControlPlaneToSupervisorMessage) => void;
  /** The connection can never succeed again; the supervisor should exit. */
  onFatalError: (error: Error) => void;
  timing?: Partial<ConnectionTiming>;
};

/** Upgrade refusals that mean this supervisor's credentials are not accepted. */
const credentialRefusalStatusCodes = [401, 403];
const handshakeTimeoutInMilliseconds = 10_000;
const closeTimeoutInMilliseconds = 2_000;
const normalClosureCode = 1000;

/**
 * The supervisor's one connection to the control plane. The supervisor dials
 * out and keeps redialling, so the sandbox needs no inbound networking.
 *
 * While disconnected, agent events wait in a bounded backlog and are sent in
 * order on reconnect; stream fragments are dropped, because the completed
 * message that follows them is the record. Events in flight when a
 * connection drops can be lost: acknowledged delivery comes in Milestone 2.
 */
export class ControlPlaneConnection {
  readonly #settings: ControlPlaneConnectionSettings;
  readonly #timing: ConnectionTiming;
  readonly #logger: Logger;
  readonly #backlog: AgentEventBacklog;
  #socket: WebSocket | undefined;
  #reconnectAttempt = 0;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #lastHeardAt = 0;
  #droppedFragmentCount = 0;
  #isClosedByUs = false;
  #hasFailed = false;

  constructor(settings: ControlPlaneConnectionSettings) {
    this.#settings = settings;
    this.#timing = { ...defaultConnectionTiming, ...settings.timing };
    this.#logger = settings.logger;
    this.#backlog = new AgentEventBacklog(this.#timing.backlogMaximumLength);
  }

  open(): void {
    this.#connect();
  }

  send(message: SupervisorToControlPlaneMessage): void {
    // Once closed or failed for good the supervisor is exiting, and the
    // reason has already been logged.
    if (this.#hasFailed || this.#isClosedByUs) {
      return;
    }
    const frame = JSON.stringify(message);
    const socket = this.#socket;
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      this.#sendFrame(socket, frame);
      return;
    }
    if (message.type === "stream_fragment") {
      this.#droppedFragmentCount += 1;
      return;
    }
    if (!this.#backlog.add(frame)) {
      this.#fail(
        new Error(
          `The control plane has been unreachable for too long: more than ${this.#timing.backlogMaximumLength} characters of agent events are waiting to be sent.`,
        ),
      );
    }
  }

  async close(): Promise<void> {
    this.#isClosedByUs = true;
    clearTimeout(this.#reconnectTimer);
    this.#stopHeartbeat();
    if (this.#backlog.frameCount > 0) {
      this.#logger.warn(
        { eventCount: this.#backlog.frameCount },
        "Closing with agent events the control plane never received",
      );
    }
    const socket = this.#socket;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      const terminateTimer = setTimeout(() => socket.terminate(), closeTimeoutInMilliseconds);
      socket.once("close", () => {
        clearTimeout(terminateTimer);
        resolve();
      });
      socket.close(normalClosureCode, "The supervisor is shutting down.");
    });
  }

  #connect(): void {
    const url = `${this.#settings.controlPlaneUrl}${buildSupervisorEndpointPath({ threadId: this.#settings.threadId })}`;
    this.#logger.info({ url }, "Connecting to the control plane");
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.#settings.supervisorToken}` },
      handshakeTimeout: handshakeTimeoutInMilliseconds,
    });
    this.#socket = socket;
    socket.on("open", () => this.#handleOpen(socket));
    socket.on("message", (data, isBinary) => this.#handleFrame(data, isBinary));
    socket.on("ping", () => this.#noteTraffic());
    socket.on("pong", () => this.#noteTraffic());
    socket.on("unexpected-response", (_request, response) => this.#handleRefusal(socket, response));
    socket.on("error", (error) =>
      this.#logger.warn({ err: error }, "Control plane connection error"),
    );
    socket.on("close", (code, reason) => this.#handleClose(code, reason.toString()));
  }

  #handleOpen(socket: WebSocket): void {
    this.#reconnectAttempt = 0;
    this.#startHeartbeat(socket);
    const backlogFrames = this.#backlog.takeAll();
    this.#logger.info(
      { backlogEventCount: backlogFrames.length, droppedFragmentCount: this.#droppedFragmentCount },
      "Connected to the control plane",
    );
    this.#droppedFragmentCount = 0;
    for (const frame of backlogFrames) {
      this.#sendFrame(socket, frame);
    }
  }

  #sendFrame(socket: WebSocket, frame: string): void {
    socket.send(frame, (error) => {
      if (error !== undefined && error !== null) {
        this.#logger.warn({ err: error }, "Sending a frame to the control plane failed");
      }
    });
  }

  #handleFrame(data: RawData, isBinary: boolean): void {
    this.#noteTraffic();
    if (isBinary) {
      this.#logger.warn("Ignoring a binary frame from the control plane");
      return;
    }
    const parsed = parseControlPlaneToSupervisorMessage(data.toString());
    if (!parsed.ok) {
      this.#logger.warn(
        { reason: parsed.errorMessage },
        "Ignoring an invalid frame from the control plane",
      );
      return;
    }
    this.#settings.onMessage(parsed.value);
  }

  /**
   * The control plane answered the upgrade with an HTTP error. Wrong
   * credentials will stay wrong, so those end the supervisor; anything else
   * (the control plane starting up, a proxy hiccup) is retried.
   */
  #handleRefusal(socket: WebSocket, response: IncomingMessage): void {
    const statusCode = response.statusCode ?? 0;
    this.#logger.warn({ statusCode }, "The control plane refused the connection");
    if (credentialRefusalStatusCodes.includes(statusCode)) {
      this.#fail(
        new Error(`The control plane refused this supervisor's credentials (HTTP ${statusCode}).`),
      );
    }
    // Aborts the handshake; `close` follows and decides whether to retry.
    socket.terminate();
  }

  #handleClose(code: number, reason: string): void {
    this.#stopHeartbeat();
    this.#socket = undefined;
    if (this.#isClosedByUs || this.#hasFailed) {
      return;
    }
    this.#logger.warn({ code, reason }, "Disconnected from the control plane");
    if (code === closeCodes.supersededByNewerSupervisor) {
      this.#fail(new Error("A newer supervisor connected for this thread, so this one must stop."));
      return;
    }
    if (code === closeCodes.invalidMessage) {
      // The frame is gone either way, and leaving would strand the agent, so
      // the supervisor reconnects; the error points at the bug to fix.
      this.#logger.error({ reason }, "The control plane rejected a message from this supervisor");
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    const delay = computeReconnectDelay(this.#reconnectAttempt, this.#timing);
    this.#reconnectAttempt += 1;
    this.#logger.info(
      { delayInMilliseconds: Math.round(delay) },
      "Reconnecting to the control plane later",
    );
    this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
  }

  /**
   * Pings keep proxies from closing an idle connection and prove the control
   * plane is still there: a half-open connection (a vanished network, a
   * frozen peer) otherwise looks healthy until a write fails much later.
   * https://github.com/websockets/ws#how-to-detect-and-close-broken-connections
   */
  #startHeartbeat(socket: WebSocket): void {
    this.#noteTraffic();
    this.#heartbeatTimer = setInterval(() => {
      if (Date.now() - this.#lastHeardAt > this.#timing.heartbeatTimeoutInMilliseconds) {
        this.#logger.warn("The control plane stopped answering pings; dropping the connection");
        socket.terminate();
        return;
      }
      socket.ping();
    }, this.#timing.heartbeatIntervalInMilliseconds);
  }

  #stopHeartbeat(): void {
    clearInterval(this.#heartbeatTimer);
  }

  #noteTraffic(): void {
    this.#lastHeardAt = Date.now();
  }

  #fail(error: Error): void {
    if (this.#hasFailed) {
      return;
    }
    this.#hasFailed = true;
    clearTimeout(this.#reconnectTimer);
    this.#logger.error({ err: error }, "The control plane connection failed for good");
    this.#settings.onFatalError(error);
  }
}
