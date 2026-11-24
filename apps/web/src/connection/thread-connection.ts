import {
  buildClientEndpointPath,
  type ClientToControlPlaneMessage,
  closeCodes,
  parseControlPlaneToClientMessage,
} from "@barrack/protocol";
import type { SessionController } from "../authentication/session-controller";
import type { AccessTokenLookup } from "../authentication/sign-in-service";
import type { ThreadStore } from "../thread-state/thread-store";
import {
  advanceConnection,
  type ConnectionEffect,
  type ConnectionEvent,
  type ConnectionMachineState,
  initialConnectionMachineState,
  type StopConsequence,
} from "./connection-machine";

/**
 * Keeps one WebSocket open to the control plane for a thread, feeding what
 * arrives into the thread's store. Before each socket is opened it obtains
 * the signed-in user's access token, which is the socket's first message,
 * and each refreshed token follows while the socket is open. Whenever the
 * connection drops it reconnects, naming the last sequence the store holds,
 * so the control plane replays exactly what was missed. The rules are in
 * `connection-machine.ts`; this carries them out.
 */
export class ThreadConnection {
  readonly #threadId: string;
  readonly #store: ThreadStore;
  readonly #session: SessionController;
  #machine: ConnectionMachineState = initialConnectionMachineState;
  #socket: WebSocket | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #stopFollowingTokens: (() => void) | undefined;

  constructor(threadId: string, store: ThreadStore, session: SessionController) {
    this.#threadId = threadId;
    this.#store = store;
    this.#session = session;
  }

  start(): void {
    this.#stopFollowingTokens = this.#session.onAccessTokenRefreshed((accessToken) =>
      this.#advance({ type: "access_token_refreshed", accessToken }),
    );
    this.#advance({ type: "attempt_started" });
  }

  stop(): void {
    this.#stopFollowingTokens?.();
    clearTimeout(this.#reconnectTimer);
    this.#advance({ type: "stop_requested" });
  }

  sendUserMessage(text: string): void {
    this.#send({ type: "send_user_message", text });
  }

  interruptAgent(): void {
    this.#send({ type: "interrupt_agent" });
  }

  #send(message: ClientToControlPlaneMessage): void {
    if (this.#socket?.readyState !== WebSocket.OPEN || this.#machine.phase !== "live") {
      console.error(`Could not send ${message.type}: the connection is not open.`);
      return;
    }
    this.#socket.send(JSON.stringify(message));
  }

  /**
   * A lookup that fails unexpectedly (a bug, not an answer) is reported and
   * treated like one that could not reach the sign-in service, so the page
   * keeps trying rather than hang or sign the user out.
   */
  #obtainAccessToken(refreshFirst: boolean): void {
    const { accessTokens } = this.#session;
    const lookup = refreshFirst
      ? accessTokens.refreshAccessToken()
      : accessTokens.currentAccessToken();
    void lookup
      .catch((error: unknown): AccessTokenLookup => {
        console.error("Could not obtain an access token:", error);
        return { status: "unavailable", reason: String(error) };
      })
      .then((result) => this.#advance({ type: "access_token_obtained", lookup: result }));
  }

  #openSocket(): void {
    const socket = new WebSocket(this.#endpointUrl());
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#socket === socket) {
        this.#advance({ type: "socket_opened" });
      }
    });
    socket.addEventListener("message", (event) => this.#receive(socket, event));
    socket.addEventListener("close", (event) => {
      if (this.#socket === socket) {
        this.#advance({ type: "socket_closed", closeCode: event.code });
      }
    });
  }

  #endpointUrl(): string {
    const lastSeenSequence = this.#store.getState().lastSeenSequence;
    const path = buildClientEndpointPath({ threadId: this.#threadId, lastSeenSequence });
    const url = new URL(path, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  }

  #receive(socket: WebSocket, event: MessageEvent): void {
    const parsed = parseControlPlaneToClientMessage(String(event.data));
    if (!parsed.ok) {
      // The page and the control plane disagree about the protocol, which a
      // reconnect would not fix.
      console.error(`The control plane sent an invalid message: ${parsed.errorMessage}`);
      socket.close(closeCodes.invalidMessage, "Invalid message");
      this.#carryOut({
        type: "stop",
        reason: "The control plane sent a message this page does not understand. Reload the page.",
        consequence: "none",
      });
      return;
    }
    if (this.#machine.phase === "authenticating") {
      this.#advance({ type: "first_message_received" });
    }
    this.#store.dispatch({ type: "message_received", message: parsed.value });
  }

  #advance(event: ConnectionEvent): void {
    const transition = advanceConnection(this.#machine, event);
    this.#machine = transition.state;
    if (event.type === "first_message_received") {
      this.#store.dispatch({ type: "connection_changed", connection: { name: "connected" } });
    }
    for (const effect of transition.effects) {
      this.#carryOut(effect);
    }
  }

  #carryOut(effect: ConnectionEffect): void {
    switch (effect.type) {
      case "obtain_access_token":
        this.#obtainAccessToken(effect.refreshFirst);
        return;
      case "open_socket":
        this.#openSocket();
        return;
      case "send_authentication":
        this.#socket?.send(
          JSON.stringify({ type: "authenticate", accessToken: effect.accessToken }),
        );
        return;
      case "close_socket":
        this.#socket?.close();
        return;
      case "retry":
        this.#store.dispatch({ type: "connection_changed", connection: { name: "reconnecting" } });
        this.#reconnectTimer = setTimeout(
          () => this.#advance({ type: "attempt_started" }),
          effect.delayInMilliseconds,
        );
        return;
      case "stop":
        this.#machine = { ...this.#machine, phase: "stopped" };
        this.#store.dispatch({
          type: "connection_changed",
          connection: { name: "stopped", reason: effect.reason },
        });
        this.#reportStop(effect.consequence);
        return;
    }
  }

  #reportStop(consequence: StopConsequence): void {
    switch (consequence) {
      case "sign_in_required":
        void this.#session.signOut();
        return;
      case "not_allowed":
        this.#session.reportNotAllowed();
        return;
      case "thread_not_found":
        this.#store.dispatch({ type: "thread_record_missing" });
        return;
      case "none":
        return;
    }
  }
}
