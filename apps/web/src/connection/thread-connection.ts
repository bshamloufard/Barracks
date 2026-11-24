import {
  buildClientEndpointPath,
  type ClientToControlPlaneMessage,
  closeCodes,
  parseControlPlaneToClientMessage,
} from "@barrack/protocol";
import type { ThreadStore } from "../thread-state/thread-store";
import { reconnectDelayInMilliseconds } from "./reconnect-delay";

/**
 * Keeps one WebSocket open to the control plane for a thread, feeding what
 * arrives into the thread's store. Whenever the connection drops it reconnects
 * after a growing delay, naming the last sequence the store holds, so the
 * control plane replays exactly what was missed.
 */
export class ThreadConnection {
  readonly #threadId: string;
  readonly #store: ThreadStore;
  #socket: WebSocket | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #failedAttemptCount = 0;
  #isStopped = false;

  constructor(threadId: string, store: ThreadStore) {
    this.#threadId = threadId;
    this.#store = store;
  }

  start(): void {
    this.#connect();
  }

  stop(): void {
    this.#isStopped = true;
    clearTimeout(this.#reconnectTimer);
    this.#socket?.close();
  }

  sendUserMessage(text: string): void {
    this.#send({ type: "send_user_message", text });
  }

  interruptAgent(): void {
    this.#send({ type: "interrupt_agent" });
  }

  #send(message: ClientToControlPlaneMessage): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      console.error(`Could not send ${message.type}: the connection is not open.`);
      return;
    }
    this.#socket.send(JSON.stringify(message));
  }

  #connect(): void {
    const socket = new WebSocket(this.#endpointUrl());
    this.#socket = socket;
    socket.addEventListener("open", () => {
      this.#failedAttemptCount = 0;
      this.#store.dispatch({ type: "connection_changed", connection: { name: "connected" } });
    });
    socket.addEventListener("message", (event) => this.#receive(socket, event));
    socket.addEventListener("close", (event) => this.#handleClose(event));
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
      this.#stopReconnecting(
        "The control plane sent a message this page does not understand. Reload the page.",
      );
      socket.close(closeCodes.invalidMessage, "Invalid message");
      return;
    }
    this.#store.dispatch({ type: "message_received", message: parsed.value });
  }

  #handleClose(event: CloseEvent): void {
    if (this.#isStopped) {
      return;
    }
    if (event.code === closeCodes.invalidMessage) {
      this.#stopReconnecting(
        "The control plane refused a message from this page as invalid. Reload the page.",
      );
      return;
    }
    this.#store.dispatch({ type: "connection_changed", connection: { name: "reconnecting" } });
    const delay = reconnectDelayInMilliseconds(this.#failedAttemptCount);
    this.#failedAttemptCount += 1;
    this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
  }

  #stopReconnecting(reason: string): void {
    this.#isStopped = true;
    this.#store.dispatch({ type: "connection_changed", connection: { name: "stopped", reason } });
  }
}
