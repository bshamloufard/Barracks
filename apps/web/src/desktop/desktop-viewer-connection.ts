import {
  buildDesktopViewerEndpointPath,
  type DesktopViewerToControlPlaneMessage,
  parseControlPlaneToDesktopViewerMessage,
} from "@barrack/protocol";
import type { SessionController } from "../authentication/session-controller";
import type { AccessTokenLookup } from "../authentication/sign-in-service";
import {
  advanceDesktopViewer,
  type DesktopViewerConditions,
  type DesktopViewerEffect,
  type DesktopViewerEvent,
  type DesktopViewerState,
  initialDesktopViewerState,
} from "./desktop-viewer-machine";

/** What the connection needs of the VNC client: noVNC, wrapped. */
export type VncClient = {
  setViewOnly(viewOnly: boolean): void;
  disconnect(): void;
};

/** Hands an open socket, past the handshake, to a new VNC client. */
export type VncClientFactory = (socket: WebSocket, viewOnly: boolean) => VncClient;

export type DesktopViewerConnectionOptions = {
  threadId: string;
  session: SessionController;
  createVncClient: VncClientFactory;
  onChange: (state: DesktopViewerState) => void;
};

/**
 * Keeps a thread's desktop viewer connected while it is wanted, following
 * the rules in `desktop-viewer-machine.ts`: it obtains a token, opens the
 * socket, authenticates with the first message, and on `desktop_ready`
 * hands the socket to noVNC in the same moment, so no VNC byte is read by
 * anything else. No credential goes in the URL. Requests for control and
 * refreshed tokens go on the same socket, as text.
 */
export class DesktopViewerConnection {
  readonly #options: DesktopViewerConnectionOptions;
  #state: DesktopViewerState = initialDesktopViewerState;
  #socket: WebSocket | undefined;
  #vncClient: VncClient | undefined;
  #isViewOnly = true;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #stopFollowingTokens: (() => void) | undefined;

  constructor(options: DesktopViewerConnectionOptions) {
    this.#options = options;
  }

  get state(): DesktopViewerState {
    return this.#state;
  }

  start(conditions: DesktopViewerConditions): void {
    this.#stopFollowingTokens = this.#options.session.onAccessTokenRefreshed((accessToken) =>
      this.#advance({ type: "access_token_refreshed", accessToken }),
    );
    this.#advance({ type: "conditions_changed", conditions });
  }

  updateConditions(conditions: DesktopViewerConditions): void {
    this.#advance({ type: "conditions_changed", conditions });
  }

  requestControl(take: boolean): void {
    this.#advance({ type: "control_requested", take });
  }

  /** A courtesy only: the control plane drops a watching viewer's input whatever this says. */
  setViewOnly(viewOnly: boolean): void {
    this.#isViewOnly = viewOnly;
    this.#vncClient?.setViewOnly(viewOnly);
  }

  stop(): void {
    this.#stopFollowingTokens?.();
    clearTimeout(this.#retryTimer);
    this.#closeSocket();
  }

  #advance(event: DesktopViewerEvent): void {
    const transition = advanceDesktopViewer(this.#state, event);
    this.#state = transition.state;
    for (const effect of transition.effects) {
      this.#carryOut(effect);
    }
    this.#options.onChange(this.#state);
  }

  #carryOut(effect: DesktopViewerEffect): void {
    switch (effect.type) {
      case "obtain_access_token":
        this.#obtainAccessToken(effect.refreshFirst);
        return;
      case "open_socket":
        this.#openSocket();
        return;
      case "send_authentication":
        this.#send({ type: "authenticate", accessToken: effect.accessToken });
        return;
      case "start_vnc":
        this.#startVnc();
        return;
      case "send_control_request":
        this.#send({ type: effect.take ? "take_desktop_control" : "release_desktop_control" });
        return;
      case "close_socket":
        this.#closeSocket();
        return;
      case "retry":
        clearTimeout(this.#retryTimer);
        this.#retryTimer = setTimeout(
          () => this.#advance({ type: "retry_due" }),
          effect.delayInMilliseconds,
        );
        return;
      case "stop":
        if (effect.consequence === "sign_in_required") {
          void this.#options.session.signOut();
        }
        if (effect.consequence === "not_allowed") {
          this.#options.session.reportNotAllowed();
        }
        return;
    }
  }

  #obtainAccessToken(refreshFirst: boolean): void {
    const { accessTokens } = this.#options.session;
    const lookup = refreshFirst
      ? accessTokens.refreshAccessToken()
      : accessTokens.currentAccessToken();
    void lookup
      .catch(
        (error: unknown): AccessTokenLookup => ({ status: "unavailable", reason: String(error) }),
      )
      .then((result) => this.#advance({ type: "access_token_obtained", lookup: result }));
  }

  #openSocket(): void {
    const url = new URL(
      buildDesktopViewerEndpointPath({ threadId: this.#options.threadId }),
      window.location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url.href);
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#socket === socket) {
        this.#advance({ type: "socket_opened" });
      }
    });
    socket.addEventListener("message", (event) => this.#receiveBeforeReady(socket, event));
    socket.addEventListener("close", (event) => {
      if (this.#socket === socket) {
        this.#socket = undefined;
        this.#disconnectVnc();
        this.#advance({ type: "socket_closed", closeCode: event.code });
      }
    });
  }

  /** Once noVNC has the socket it replaces this handler, so this sees only what comes before. */
  #receiveBeforeReady(socket: WebSocket, event: MessageEvent): void {
    if (this.#socket !== socket || typeof event.data !== "string") {
      return;
    }
    const parsed = parseControlPlaneToDesktopViewerMessage(event.data);
    if (!parsed.ok) {
      console.error(
        `The control plane sent the desktop an invalid message: ${parsed.errorMessage}`,
      );
      socket.close();
      return;
    }
    const message = parsed.value;
    this.#advance(
      message.type === "desktop_ready"
        ? { type: "ready_received", viewerId: message.viewerId }
        : {
            type: "unavailable_received",
            reason: message.reason,
            explanation: message.explanation,
          },
    );
  }

  #startVnc(): void {
    const socket = this.#socket;
    if (socket !== undefined) {
      this.#vncClient = this.#options.createVncClient(socket, this.#isViewOnly);
    }
  }

  #send(message: DesktopViewerToControlPlaneMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message));
    }
  }

  #closeSocket(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#disconnectVnc();
    socket?.close();
  }

  #disconnectVnc(): void {
    this.#vncClient?.disconnect();
    this.#vncClient = undefined;
  }
}
