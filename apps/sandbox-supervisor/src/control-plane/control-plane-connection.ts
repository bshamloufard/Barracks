import type { ClientRequest, IncomingMessage } from "node:http";
import {
  type AgentEventMessage,
  buildSupervisorEndpointPath,
  type ConfigureModelAccess,
  type ControlPlaneDesktopMessage,
  type ControlPlaneToSupervisorMessage,
  type CreatePublicationBundle,
  closeCodes,
  type DeliverUserMessage,
  type InterruptAgentMessage,
  maximumUnconfirmedAgentEventsLength,
  type PrepareWorkspace,
  parseControlPlaneToSupervisorMessage,
  type RepositoryCredential,
  type StreamFragment,
  type SupervisorDesktopMessage,
  type SupervisorEvent,
  type SupervisorToControlPlaneMessage,
  type SupervisorWorkspaceMessage,
} from "@barrack/protocol";
import WebSocket, { type RawData } from "ws";
import type { Logger } from "../logger.js";
import { computeReconnectDelay, type ReconnectDelaySettings } from "./reconnect-delay.js";
import { UnconfirmedAgentEvents } from "./unconfirmed-agent-events.js";

export type ConnectionTiming = ReconnectDelaySettings & {
  /** How often the supervisor pings the control plane. */
  heartbeatIntervalInMilliseconds: number;
  /** Silence from the control plane longer than this means the connection is dead. */
  heartbeatTimeoutInMilliseconds: number;
  /** Agent events kept until the control plane confirms them, in characters of serialized frames. */
  unconfirmedEventsMaximumLength: number;
  /** How long closing waits for the control plane to confirm the last events. */
  closingConfirmationTimeoutInMilliseconds: number;
};

export const defaultConnectionTiming: ConnectionTiming = {
  initialDelayInMilliseconds: 500,
  maximumDelayInMilliseconds: 15_000,
  heartbeatIntervalInMilliseconds: 15_000,
  heartbeatTimeoutInMilliseconds: 35_000,
  // About 64 MB of memory at most. The control plane counts on no more.
  unconfirmedEventsMaximumLength: maximumUnconfirmedAgentEventsLength,
  closingConfirmationTimeoutInMilliseconds: 5_000,
};

/**
 * What the control plane asks of the agent and its workspace, carried out
 * in the order it arrives: the workspace and the model access are described
 * before any user message, so none reaches the agent before its repository
 * and its key do.
 */
export type AgentRequest =
  | DeliverUserMessage
  | InterruptAgentMessage
  | PrepareWorkspace
  | ConfigureModelAccess;

/** The workspace's requests and answers that need not wait their turn behind the agent's. */
export type WorkspaceMessage = RepositoryCredential | CreatePublicationBundle;

export type ControlPlaneConnectionSettings = {
  /** For example `ws://127.0.0.1:8787`, without a trailing slash. */
  controlPlaneUrl: string;
  threadId: string;
  supervisorToken: string;
  /** Identifies this supervisor process to the control plane; minted afresh each time it starts. */
  supervisorInstanceId: string;
  /** How far the agent has been handed user messages, told to the control plane on every connection. */
  readUserMessagesDeliveredThrough: () => number;
  logger: Logger;
  onAgentRequest: (request: AgentRequest) => void;
  onWorkspaceMessage: (message: WorkspaceMessage) => void;
  /** The desktop's requests, which need not wait behind the agent's either. */
  onDesktopMessage: (message: ControlPlaneDesktopMessage) => void;
  /** A connection was welcomed, so whatever the control plane must hear on each may be sent. */
  onWelcomed: () => void;
  /** The connection can never succeed again; the supervisor should exit. */
  onFatalError: (error: Error) => void;
  timing?: Partial<ConnectionTiming>;
};

/**
 * The client errors that say "not now" rather than "never": a request that
 * timed out, and being asked to slow down. Every other 4xx answer to the
 * upgrade (wrong credentials, a protocol version the control plane does not
 * speak, an endpoint that does not exist) will be the same on every retry.
 */
const retryableClientErrorStatusCodes = [408, 429];
const handshakeTimeoutInMilliseconds = 10_000;
const closeTimeoutInMilliseconds = 2_000;
/** Enough of a refusal's body to say why, such as which protocol version was expected. */
const maximumRefusalReasonLength = 1024;
const normalClosureCode = 1000;

/**
 * The supervisor's one connection to the control plane. The supervisor dials
 * out and keeps redialling, so the sandbox needs no inbound networking.
 *
 * Every connection starts with the handshake described in
 * `packages/protocol/src/supervisor-messages.ts`: a hello, then the
 * welcome, which says which of this process's agent events are recorded.
 * Each agent event is numbered and kept until the control plane confirms it
 * is recorded, and everything unconfirmed is sent again, in order, after
 * each welcome, so an event survives the connection dying, half-open or
 * not, and the control plane restarting. Stream fragments are sent only on
 * a welcomed connection and otherwise dropped: the completed message that
 * follows them is the record.
 *
 * Unconfirmed events are kept in memory only. They survive any outage of
 * the control plane but not this process ending; see the supervisor's README.
 */
export class ControlPlaneConnection {
  readonly #settings: ControlPlaneConnectionSettings;
  readonly #timing: ConnectionTiming;
  readonly #logger: Logger;
  readonly #unconfirmedEvents: UnconfirmedAgentEvents;
  #nextEventNumber = 1;
  #socket: WebSocket | undefined;
  /** Set once the current socket's hello has been answered; only then may events go out. */
  #isWelcomed = false;
  #reconnectAttempt = 0;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #lastHeardAt = 0;
  #droppedFragmentCount = 0;
  #isClosedByUs = false;
  #hasFailed = false;
  #allConfirmed: PromiseWithResolvers<void> | undefined;

  constructor(settings: ControlPlaneConnectionSettings) {
    this.#settings = settings;
    this.#timing = { ...defaultConnectionTiming, ...settings.timing };
    this.#logger = settings.logger;
    this.#unconfirmedEvents = new UnconfirmedAgentEvents(
      this.#timing.unconfirmedEventsMaximumLength,
    );
  }

  open(): void {
    this.#connect();
  }

  /**
   * Numbers the event, keeps it until it is confirmed, and sends it now if
   * the connection is welcomed. If too much is waiting for confirmation, the
   * connection fails for good, and the supervisor exits, rather than drop an
   * event or run out of memory.
   */
  sendAgentEvent(event: SupervisorEvent): void {
    // Once closed or failed for good the supervisor is exiting, and the
    // reason has already been logged.
    if (this.#hasFailed || this.#isClosedByUs) {
      return;
    }
    const eventNumber = this.#nextEventNumber;
    this.#nextEventNumber += 1;
    const message: AgentEventMessage = { type: "agent_event", eventNumber, event };
    const frame = JSON.stringify(message);
    if (!this.#unconfirmedEvents.add({ eventNumber, frame })) {
      this.#fail(
        new Error(
          `The control plane has not confirmed this supervisor's agent events for too long: more than ${this.#timing.unconfirmedEventsMaximumLength} characters of them are waiting. The ${this.#unconfirmedEvents.count} unconfirmed events are lost with this supervisor.`,
        ),
      );
      return;
    }
    this.#sendOnWelcomedSocket(frame);
  }

  sendStreamFragment(fragment: StreamFragment): void {
    const frame = JSON.stringify({ type: "stream_fragment", fragment });
    if (!this.#sendOnWelcomedSocket(frame)) {
      this.#droppedFragmentCount += 1;
    }
  }

  /**
   * Sends a workspace request or answer if the connection is welcomed;
   * returns whether it went out. Not kept for resending: whoever asked gives
   * up and may ask again.
   */
  sendWorkspaceMessage(message: SupervisorWorkspaceMessage): boolean {
    return this.#sendOnWelcomedSocket(JSON.stringify(message));
  }

  /**
   * Sends a desktop report if the connection is welcomed; returns whether it
   * went out. Not kept for resending: the desktop's availability is sent
   * again after every welcome, and a failed stream's viewer gives up.
   */
  sendDesktopMessage(message: SupervisorDesktopMessage): boolean {
    return this.#sendOnWelcomedSocket(JSON.stringify(message));
  }

  /** Not kept for resending: every new connection's hello says the same. */
  acknowledgeUserMessages(throughSequence: number): void {
    this.#sendOnWelcomedSocket(
      JSON.stringify({ type: "user_messages_delivered", throughSequence }),
    );
  }

  /**
   * Waits a little for the control plane to confirm the last events, so a
   * supervisor stopping cleanly loses none of them, then closes.
   */
  async close(): Promise<void> {
    await this.#waitUntilAllConfirmed();
    this.#isClosedByUs = true;
    clearTimeout(this.#reconnectTimer);
    this.#stopHeartbeat();
    if (this.#unconfirmedEvents.count > 0) {
      this.#logger.error(
        { eventCount: this.#unconfirmedEvents.count },
        "Closing with agent events the control plane never confirmed; they are lost",
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

  async #waitUntilAllConfirmed(): Promise<void> {
    if (this.#unconfirmedEvents.count === 0 || this.#hasFailed) {
      return;
    }
    this.#allConfirmed ??= Promise.withResolvers<void>();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#timing.closingConfirmationTimeoutInMilliseconds);
    });
    await Promise.race([this.#allConfirmed.promise, timedOut]);
    clearTimeout(timer);
  }

  #connect(): void {
    const url = `${this.#settings.controlPlaneUrl}${buildSupervisorEndpointPath({ threadId: this.#settings.threadId })}`;
    this.#logger.info({ url }, "Connecting to the control plane");
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.#settings.supervisorToken}` },
      handshakeTimeout: handshakeTimeoutInMilliseconds,
    });
    this.#socket = socket;
    this.#isWelcomed = false;
    socket.on("open", () => this.#handleOpen(socket));
    socket.on("message", (data, isBinary) => this.#handleFrame(data, isBinary));
    socket.on("ping", () => this.#noteTraffic());
    socket.on("pong", () => this.#noteTraffic());
    socket.on("unexpected-response", (request, response) =>
      this.#handleRefusal(socket, request, response),
    );
    socket.on("error", (error) =>
      this.#logger.warn({ err: error }, "Control plane connection error"),
    );
    socket.on("close", (code, reason) => this.#handleClose(code, reason.toString()));
  }

  #handleOpen(socket: WebSocket): void {
    this.#reconnectAttempt = 0;
    this.#startHeartbeat(socket);
    const hello: SupervisorToControlPlaneMessage = {
      type: "supervisor_hello",
      supervisorInstanceId: this.#settings.supervisorInstanceId,
      userMessagesDeliveredThroughSequence: this.#settings.readUserMessagesDeliveredThrough(),
    };
    this.#logger.info(
      { userMessagesDeliveredThroughSequence: hello.userMessagesDeliveredThroughSequence },
      "Connected to the control plane; saying hello",
    );
    this.#sendFrame(socket, JSON.stringify(hello));
  }

  /**
   * The control plane may have recorded events whose confirmation was lost,
   * so it says how far it got and those are forgotten before the rest go
   * out again. It can never be behind what it confirmed earlier unless its
   * history lost events, which this supervisor cannot repair.
   */
  #handleWelcome(lastRecordedEventNumber: number): void {
    const socket = this.#socket;
    if (socket === undefined) {
      return;
    }
    const lastConfirmedEventNumber =
      (this.#unconfirmedEvents.oldestEventNumber ?? this.#nextEventNumber) - 1;
    const isImpossible =
      lastRecordedEventNumber < lastConfirmedEventNumber ||
      lastRecordedEventNumber >= this.#nextEventNumber;
    if (isImpossible) {
      this.#fail(
        new Error(
          `The control plane says it recorded this supervisor's events through number ${lastRecordedEventNumber}, but it had confirmed them through ${lastConfirmedEventNumber} and only ${this.#nextEventNumber - 1} exist; its history no longer matches what it confirmed.`,
        ),
      );
      socket.terminate();
      return;
    }
    this.#forgetConfirmedEvents(lastRecordedEventNumber);
    this.#isWelcomed = true;
    this.#logger.info(
      {
        lastRecordedEventNumber,
        resentEventCount: this.#unconfirmedEvents.count,
        droppedFragmentCount: this.#droppedFragmentCount,
      },
      "Welcomed by the control plane; sending the events it lacks",
    );
    this.#droppedFragmentCount = 0;
    for (const { frame } of this.#unconfirmedEvents.frames) {
      this.#sendFrame(socket, frame);
    }
    this.#settings.onWelcomed();
  }

  #handleEventsRecorded(throughEventNumber: number): void {
    if (throughEventNumber >= this.#nextEventNumber) {
      this.#logger.warn(
        { throughEventNumber, lastEventNumber: this.#nextEventNumber - 1 },
        "Ignoring a confirmation of agent events this supervisor never sent",
      );
      return;
    }
    this.#forgetConfirmedEvents(throughEventNumber);
  }

  #forgetConfirmedEvents(throughEventNumber: number): void {
    this.#unconfirmedEvents.forgetThrough(throughEventNumber);
    if (this.#unconfirmedEvents.count === 0) {
      this.#allConfirmed?.resolve();
      this.#allConfirmed = undefined;
    }
  }

  /** Returns whether the frame went out, which it does only on a welcomed, open socket. */
  #sendOnWelcomedSocket(frame: string): boolean {
    const socket = this.#socket;
    if (!this.#isWelcomed || socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.#sendFrame(socket, frame);
    return true;
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
    this.#handleMessage(parsed.value);
  }

  #handleMessage(message: ControlPlaneToSupervisorMessage): void {
    switch (message.type) {
      case "supervisor_welcome":
        this.#handleWelcome(message.lastRecordedEventNumber);
        return;
      case "agent_events_recorded":
        this.#handleEventsRecorded(message.throughEventNumber);
        return;
      case "deliver_user_message":
      case "interrupt_agent":
      case "prepare_workspace":
      case "configure_model_access":
        this.#settings.onAgentRequest(message);
        return;
      case "repository_credential":
      case "create_publication_bundle":
        this.#settings.onWorkspaceMessage(message);
        return;
      case "open_desktop_stream":
      case "desktop_control":
        this.#settings.onDesktopMessage(message);
        return;
    }
  }

  /**
   * The control plane answered the upgrade with an HTTP error. A refusal
   * that can never turn into a yes ends the supervisor, with the reason the
   * control plane gave (such as the protocol version it expected); anything
   * else (the control plane starting up, a proxy hiccup) is retried.
   */
  #handleRefusal(socket: WebSocket, request: ClientRequest, response: IncomingMessage): void {
    const statusCode = response.statusCode ?? 0;
    this.#logger.warn({ statusCode }, "The control plane refused the connection");
    if (!isPermanentRefusal(statusCode)) {
      // Aborts the handshake; `close` follows and schedules a retry.
      socket.terminate();
      return;
    }
    // Given up at once, so the socket closing while the reason is read
    // cannot schedule a retry.
    this.#hasFailed = true;
    clearTimeout(this.#reconnectTimer);
    void readRefusalReason(response).then((reason) => {
      request.destroy();
      socket.terminate();
      this.#reportFatalError(
        new Error(
          `The control plane refused this supervisor's connection (HTTP ${statusCode}: ${reason}), and retrying cannot change that.`,
        ),
      );
    });
  }

  #handleClose(code: number, reason: string): void {
    this.#stopHeartbeat();
    this.#socket = undefined;
    this.#isWelcomed = false;
    if (this.#isClosedByUs || this.#hasFailed) {
      return;
    }
    this.#logger.warn(
      { code, reason, unconfirmedEventCount: this.#unconfirmedEvents.count },
      "Disconnected from the control plane",
    );
    if (code === closeCodes.supersededByNewerSupervisor) {
      this.#fail(new Error("A newer supervisor connected for this thread, so this one must stop."));
      return;
    }
    if (code === closeCodes.invalidMessage) {
      // Leaving would strand the agent, so the supervisor reconnects; the
      // error points at the bug to fix.
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
    this.#reportFatalError(error);
  }

  #reportFatalError(error: Error): void {
    this.#allConfirmed?.resolve();
    this.#logger.error({ err: error }, "The control plane connection failed for good");
    this.#settings.onFatalError(error);
  }
}

function isPermanentRefusal(statusCode: number): boolean {
  const isClientError = statusCode >= 400 && statusCode < 500;
  return isClientError && !retryableClientErrorStatusCodes.includes(statusCode);
}

/** The first line of the refusal's body, which the control plane fills with the reason. */
function readRefusalReason(response: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    const finish = () => resolve(body.trim().split("\n")[0] || "no reason given");
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      body = (body + chunk).slice(0, maximumRefusalReasonLength);
    });
    response.once("end", finish);
    response.once("error", finish);
    response.once("close", finish);
  });
}
