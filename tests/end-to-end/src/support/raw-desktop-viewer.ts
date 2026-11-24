import {
  buildDesktopViewerEndpointPath,
  type ControlPlaneToDesktopViewerMessage,
  parseControlPlaneToDesktopViewerMessage,
} from "@barrack/protocol";
import { WebSocket } from "ws";
import { testClientOrigin } from "./local-system.js";

const waitInMilliseconds = 15_000;

/**
 * A desktop viewer that speaks VNC itself rather than through noVNC, so a
 * test can send what a page would not: keystrokes from a viewer that does
 * not hold control, which the control plane must drop.
 */
export class RawDesktopViewer {
  readonly messages: ControlPlaneToDesktopViewerMessage[] = [];
  readonly closed: Promise<number>;
  readonly #socket: WebSocket;
  #receivedBytes = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    this.closed = new Promise((resolve) => socket.once("close", (closeCode) => resolve(closeCode)));
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.#receivedBytes += (data as Buffer).length;
        return;
      }
      const parsed = parseControlPlaneToDesktopViewerMessage(String(data));
      if (parsed.ok) {
        this.messages.push(parsed.value);
      }
    });
  }

  /** Opens the thread's desktop as the user the token is for. */
  static async open(webSocketBaseUrl: string, threadId: string, accessToken: string) {
    const socket = new WebSocket(
      `${webSocketBaseUrl}${buildDesktopViewerEndpointPath({ threadId })}`,
      { headers: { Origin: testClientOrigin } },
    );
    const viewer = new RawDesktopViewer(socket);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "authenticate", accessToken }));
    return viewer;
  }

  /** Waits for `desktop_ready`, then completes the VNC handshake as noVNC would (RFB 3.8, None). */
  async startVnc(): Promise<void> {
    await this.#waitUntil("the desktop is ready", () =>
      this.messages.some((message) => message.type === "desktop_ready"),
    );
    await this.#waitUntil("the server's version", () => this.#receivedBytes >= 12);
    this.#socket.send(Buffer.from("RFB 003.008\n"));
    await this.#waitUntil("the security types", () => this.#receivedBytes >= 14);
    this.#socket.send(Buffer.from([1]));
    await this.#waitUntil("the security result", () => this.#receivedBytes >= 18);
    this.#socket.send(Buffer.from([0]));
    await this.#waitUntil("the server's initialisation", () => this.#receivedBytes >= 42);
  }

  /** Presses and releases a key for each character, as X keysyms (Latin-1 letters are their codes). */
  typeKeys(text: string): void {
    for (const character of text) {
      for (const isDown of [1, 0]) {
        const keyEvent = Buffer.alloc(8);
        keyEvent.writeUInt8(4, 0);
        keyEvent.writeUInt8(isDown, 1);
        keyEvent.writeUInt32BE(character.charCodeAt(0), 4);
        this.#socket.send(keyEvent);
      }
    }
  }

  close(): void {
    this.#socket.close();
  }

  async #waitUntil(description: string, isDone: () => boolean): Promise<void> {
    const deadline = Date.now() + waitInMilliseconds;
    while (!isDone()) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(this.messages)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
