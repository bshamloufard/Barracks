import { randomBytes } from "node:crypto";
import {
  type ControlPlaneToDesktopViewerMessage,
  closeCodes,
  type DesktopUnavailableReason,
  type DesktopViewerEndpointParameters,
  type DesktopViewerToControlPlaneMessage,
  parseDesktopViewerToControlPlaneMessage,
} from "@barrack/protocol";
import type { RawData, WebSocket } from "ws";
import { DesktopSplice, type SpliceEnding } from "../desktop/desktop-splice.js";
import { rawDataBytes } from "../desktop/raw-data-bytes.js";
import { RfbViewerFilter } from "../desktop/rfb-viewer-filter.js";
import type { Logger } from "../logger.js";
import { standardCloseCodes } from "../standard-close-codes.js";
import { ConnectionAuthentication } from "./connection-authentication.js";
import { keepConnectionAlive } from "./heartbeat.js";
import {
  largestUnauthenticatedClientInputInBytes,
  type UnauthenticatedByteLimit,
} from "./unauthenticated-byte-limit.js";
import type { UpgradeDependencies } from "./upgrade-dependencies.js";

/**
 * Where a viewer's connection is in its life:
 * - `awaiting_authentication`: only an `authenticate` message is acceptable;
 * - `preparing`: the owner is being checked and the stream opened; the
 *   viewer must wait for `desktop_ready`;
 * - `streaming`: spliced to the sandbox's desktop;
 * - `closed`: the connection has closed, so nothing more is done.
 */
type Phase =
  | { name: "awaiting_authentication" }
  | { name: "preparing" }
  | { name: "streaming"; viewerId: string; splice: DesktopSplice }
  | { name: "closed" };

type Unavailability = { reason: DesktopUnavailableReason; explanation: string };

/**
 * One viewer's connection to a thread's desktop, from the upgrade until it
 * closes; the handshake is in `packages/protocol/src/desktop-messages.ts`.
 * It authenticates exactly as a thread's client connection does
 * (`ConnectionAuthentication`), so another user's thread is answered as a
 * missing one, and an expired token closes it. It never wakes a sandbox:
 * a viewer of a stopped thread is told so. Once spliced, its binary frames
 * are VNC data for the filter, and its text frames are newer tokens and
 * requests to take or give back control.
 */
export class DesktopViewerSession {
  readonly #webSocket: WebSocket;
  readonly #threadId: string;
  readonly #dependencies: UpgradeDependencies;
  readonly #logger: Logger;
  readonly #byteLimit: UnauthenticatedByteLimit;
  readonly #authentication: ConnectionAuthentication;
  #phase: Phase = { name: "awaiting_authentication" };
  #authenticationDeadline: ReturnType<typeof setTimeout> | undefined;

  constructor(
    webSocket: WebSocket,
    endpoint: DesktopViewerEndpointParameters,
    dependencies: UpgradeDependencies,
    logger: Logger,
    byteLimit: UnauthenticatedByteLimit,
  ) {
    this.#webSocket = webSocket;
    this.#threadId = endpoint.threadId;
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
    this.#logger.info("Desktop viewer connected");
    keepConnectionAlive(
      this.#webSocket,
      this.#dependencies.heartbeatIntervalInMilliseconds,
      this.#logger,
    );
    this.#authenticationDeadline = setTimeout(
      () => this.#close(closeCodes.authenticationTimedOut, "Did not authenticate in time"),
      this.#dependencies.clientAuthenticationTimeoutInMilliseconds,
    );
    this.#webSocket.on("error", (error) =>
      this.#logger.warn({ err: error }, "Desktop viewer connection failed"),
    );
    this.#webSocket.on("close", () => this.#handleClose());
    this.#webSocket.on("message", (data, isBinary) => this.#receive(data, isBinary));
  }

  #receive(data: RawData, isBinary: boolean): void {
    const phase = this.#phase;
    if (phase.name === "streaming" && isBinary) {
      phase.splice.forwardFromViewer(rawDataBytes(data));
      return;
    }
    if (isBinary || phase.name === "closed") {
      this.#close(closeCodes.notAuthenticated, "Authenticate first, then wait for the desktop");
      return;
    }
    const message = this.#parseTextFrame(data);
    if (message === undefined) {
      return;
    }
    if (phase.name === "awaiting_authentication" && message.type === "authenticate") {
      this.#phase = { name: "preparing" };
      clearTimeout(this.#authenticationDeadline);
      void this.#prepare(message.accessToken);
      return;
    }
    if (phase.name !== "streaming") {
      this.#close(closeCodes.notAuthenticated, "Authenticate first, then wait for the desktop");
      return;
    }
    this.#carryOut(message, phase.viewerId);
  }

  /** No text frame is larger than an `authenticate` message; anything else breaks the rules. */
  #parseTextFrame(data: RawData): DesktopViewerToControlPlaneMessage | undefined {
    const frame = rawDataBytes(data);
    if (frame.length > largestUnauthenticatedClientInputInBytes) {
      this.#close(closeCodes.invalidMessage, "Invalid message");
      return undefined;
    }
    const parsed = parseDesktopViewerToControlPlaneMessage(frame.toString("utf8"));
    if (!parsed.ok) {
      this.#logger.warn(
        { reason: parsed.errorMessage },
        "A desktop viewer sent an invalid message",
      );
      this.#close(closeCodes.invalidMessage, "Invalid message");
      return undefined;
    }
    return parsed.value;
  }

  #carryOut(message: DesktopViewerToControlPlaneMessage, viewerId: string): void {
    const { desktops } = this.#dependencies.desktop;
    switch (message.type) {
      case "authenticate":
        this.#authentication.acceptRefreshedToken(message.accessToken);
        return;
      case "take_desktop_control":
        desktops.takeControl(this.#threadId, viewerId);
        return;
      case "release_desktop_control":
        desktops.releaseControl(this.#threadId, viewerId);
        return;
    }
  }

  async #prepare(accessToken: string): Promise<void> {
    const owner = await this.#authentication.authenticateOwner(accessToken, this.#threadId);
    if (owner === undefined || this.#phase.name === "closed") {
      return;
    }
    this.#byteLimit.lift();
    let unavailability: Unavailability | undefined;
    try {
      unavailability = await this.#findUnavailability();
    } catch (error) {
      this.#logger.error({ err: error }, "Could not look up the thread a desktop viewer asked for");
      this.#close(standardCloseCodes.tryAgainLater, "Could not look up the thread; try again");
      return;
    }
    if (unavailability !== undefined) {
      this.#refuse(unavailability);
      return;
    }
    const viewerId = randomBytes(16).toString("hex");
    const { desktops } = this.#dependencies.desktop;
    if (!desktops.admitViewer(this.#threadId, { viewerId })) {
      this.#refuse({
        reason: "too_many_viewers",
        explanation: "This desktop has as many viewers as it may. Close one and try again.",
      });
      return;
    }
    await this.#openStream(viewerId, owner.user.userId);
  }

  async #openStream(viewerId: string, userId: string): Promise<void> {
    const { desktops } = this.#dependencies.desktop;
    const outcome = await desktops.streamRequests.request(this.#threadId, (streamId) =>
      this.#dependencies.relays.sendDesktopMessage(this.#threadId, {
        type: "open_desktop_stream",
        streamId,
      }),
    );
    if (!outcome.ok) {
      desktops.removeViewer(this.#threadId, viewerId);
      this.#refuse({ reason: "stream_not_opened", explanation: outcome.reason });
      return;
    }
    if (this.#phase.name === "closed") {
      outcome.streamSocket.terminate();
      desktops.removeViewer(this.#threadId, viewerId);
      return;
    }
    this.#send({ type: "desktop_ready", viewerId });
    const splice = new DesktopSplice({
      viewerSocket: this.#webSocket,
      streamSocket: outcome.streamSocket,
      filter: new RfbViewerFilter({
        isInputAllowed: () => desktops.isControlling(this.#threadId, viewerId),
        onInputForwarded: () =>
          void this.#dependencies.desktop.recordUserDesktopInput(this.#threadId),
      }),
      limits: this.#dependencies.desktop.flowLimits,
      logger: this.#logger,
      onEnd: (ending) => this.#endStream(viewerId, ending),
    });
    this.#phase = { name: "streaming", viewerId, splice };
    this.#logger.info({ userId, viewerId }, "Desktop viewer spliced to the sandbox's desktop");
  }

  /** Why the desktop cannot be shown now, if it cannot; a stopped sandbox is never woken for it. */
  async #findUnavailability(): Promise<Unavailability | undefined> {
    const thread = await this.#dependencies.threadStore.find(this.#threadId);
    if (thread?.sandbox.state !== "running") {
      return {
        reason: "sandbox_not_running",
        explanation: "The sandbox is not running. Resume the thread to see its desktop.",
      };
    }
    if (!this.#dependencies.relays.isSupervisorAttached(this.#threadId)) {
      return {
        reason: "sandbox_not_connected",
        explanation: "The sandbox has not connected yet.",
      };
    }
    const availability = this.#dependencies.desktop.desktops.availabilityOf(this.#threadId);
    switch (availability?.status) {
      case "running":
        return undefined;
      case "none":
        return {
          reason: "no_desktop",
          explanation: availability.explanation ?? "This sandbox has no desktop.",
        };
      default:
        return {
          reason: "desktop_starting",
          explanation: availability?.explanation ?? "The sandbox's desktop is starting.",
        };
    }
  }

  #endStream(viewerId: string, ending: SpliceEnding): void {
    this.#dependencies.desktop.desktops.removeViewer(this.#threadId, viewerId);
    this.#logger.info({ viewerId, ending }, "A desktop stream ended");
    switch (ending) {
      case "viewer_closed":
        return;
      case "viewer_broke_protocol":
        this.#close(closeCodes.invalidMessage, "Invalid VNC message");
        return;
      case "viewer_stalled":
        this.#close(closeCodes.clientTooSlow, "Not reading fast enough");
        return;
      case "stream_closed":
      case "stream_broke_protocol":
        this.#close(closeCodes.desktopStreamEnded, "The sandbox's desktop stream ended");
        return;
    }
  }

  #refuse(unavailability: Unavailability): void {
    this.#logger.info(
      { reason: unavailability.reason },
      "The desktop is not available to a viewer",
    );
    this.#send({ type: "desktop_unavailable", ...unavailability });
    this.#close(closeCodes.desktopUnavailable, "The desktop is not available");
  }

  #send(message: ControlPlaneToDesktopViewerMessage): void {
    if (this.#webSocket.readyState === this.#webSocket.OPEN) {
      this.#webSocket.send(JSON.stringify(message));
    }
  }

  /** Close reasons must fit in 123 bytes, so they stay short. */
  #close(closeCode: number, reason: string): void {
    if (this.#webSocket.readyState === this.#webSocket.OPEN) {
      this.#logger.info({ closeCode, reason }, "Closing a desktop viewer connection");
      this.#webSocket.close(closeCode, reason);
    }
  }

  #handleClose(): void {
    const phase = this.#phase;
    this.#phase = { name: "closed" };
    clearTimeout(this.#authenticationDeadline);
    this.#authentication.dispose();
    this.#logger.info("Desktop viewer disconnected");
    if (phase.name === "streaming") {
      phase.splice.end("viewer_closed");
    }
  }
}
