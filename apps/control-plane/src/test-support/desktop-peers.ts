import {
  buildDesktopStreamEndpointPath,
  buildDesktopViewerEndpointPath,
  type ControlPlaneToDesktopViewerMessage,
  parseControlPlaneToDesktopViewerMessage,
} from "@barrack/protocol";
import { WebSocket } from "ws";
import type { FakeSupervisor } from "./test-peers.js";
import type { CloseOutcome } from "./test-socket.js";

const waitInMilliseconds = 2_000;

/** Collects bytes as they arrive and lets a test wait until enough have. */
class ByteCollector {
  #bytes = Buffer.alloc(0);
  readonly #waiters = new Set<() => void>();

  get bytes(): Buffer {
    return this.#bytes;
  }

  add(chunk: Buffer): void {
    this.#bytes = Buffer.concat([this.#bytes, chunk]);
    for (const waiter of this.#waiters) {
      waiter();
    }
  }

  waitUntil(description: string, isEnough: (bytes: Buffer) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (isEnough(this.#bytes)) {
          clearTimeout(timer);
          this.#waiters.delete(check);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(check);
        reject(
          new Error(`Timed out waiting for ${description}; have ${this.#bytes.length} bytes.`),
        );
      }, waitInMilliseconds);
      this.#waiters.add(check);
      check();
    });
  }
}

/**
 * A desktop viewer as the web page is one: it authenticates with its first
 * message, reads text messages until `desktop_ready`, and from then on
 * reads and writes VNC bytes, plus text requests for control.
 */
export class TestDesktopViewer {
  readonly messages: ControlPlaneToDesktopViewerMessage[] = [];
  readonly received = new ByteCollector();
  readonly closed: Promise<CloseOutcome>;
  readonly #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    this.closed = new Promise((resolve) =>
      socket.once("close", (closeCode, reason) =>
        resolve({ closeCode, reason: reason.toString() }),
      ),
    );
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.received.add(data as Buffer);
        return;
      }
      const parsed = parseControlPlaneToDesktopViewerMessage(String(data));
      if (!parsed.ok) {
        throw new Error(
          `The control plane sent a viewer an invalid message: ${parsed.errorMessage}`,
        );
      }
      this.messages.push(parsed.value);
    });
  }

  /** Opens the connection, and authenticates at once when given a token. */
  static async open(
    baseUrl: string,
    threadId: string,
    origin: string,
    accessToken?: string,
  ): Promise<TestDesktopViewer> {
    const socket = new WebSocket(`${baseUrl}${buildDesktopViewerEndpointPath({ threadId })}`, {
      headers: { Origin: origin },
    });
    const viewer = new TestDesktopViewer(socket);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    if (accessToken !== undefined) {
      viewer.authenticate(accessToken);
    }
    return viewer;
  }

  /** The viewer's identifier once the desktop is ready, or undefined if it closed first. */
  async ready(): Promise<string | undefined> {
    const readyMessage = await Promise.race([
      new Promise<ControlPlaneToDesktopViewerMessage>((resolve) => {
        const check = setInterval(() => {
          const message = this.messages.find((candidate) => candidate.type === "desktop_ready");
          if (message !== undefined) {
            clearInterval(check);
            resolve(message);
          }
        }, 5);
        void this.closed.then(() => clearInterval(check));
      }),
      this.closed.then(() => undefined),
    ]);
    return readyMessage?.type === "desktop_ready" ? readyMessage.viewerId : undefined;
  }

  authenticate(accessToken: string): void {
    this.#socket.send(JSON.stringify({ type: "authenticate", accessToken }));
  }

  takeControl(): void {
    this.#socket.send(JSON.stringify({ type: "take_desktop_control" }));
  }

  releaseControl(): void {
    this.#socket.send(JSON.stringify({ type: "release_desktop_control" }));
  }

  sendVnc(bytes: Buffer): void {
    this.#socket.send(bytes, { binary: true });
  }

  sendRawText(text: string): void {
    this.#socket.send(text);
  }

  async close(): Promise<void> {
    if (this.#socket.readyState !== WebSocket.CLOSED) {
      this.#socket.close();
    }
    await this.closed;
  }
}

/** The sandbox's end of a desktop stream, as a supervisor dials it, with a VNC server of its own. */
export class FakeDesktopStream {
  readonly received = new ByteCollector();
  readonly closed: Promise<CloseOutcome>;
  readonly #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    this.closed = new Promise((resolve) =>
      socket.once("close", (closeCode, reason) =>
        resolve({ closeCode, reason: reason.toString() }),
      ),
    );
    socket.on("message", (data) => this.received.add(data as Buffer));
  }

  static async dial(
    baseUrl: string,
    threadId: string,
    streamId: string,
    supervisorToken: string,
  ): Promise<FakeDesktopStream> {
    const socket = new WebSocket(
      `${baseUrl}${buildDesktopStreamEndpointPath({ threadId, streamId })}`,
      { headers: { Authorization: `Bearer ${supervisorToken}` } },
    );
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new FakeDesktopStream(socket);
  }

  sendVnc(bytes: Buffer): void {
    this.#socket.send(bytes, { binary: true });
  }

  async close(): Promise<void> {
    if (this.#socket.readyState !== WebSocket.CLOSED) {
      this.#socket.close();
    }
    await this.closed;
  }
}

/** The stream the control plane asked the supervisor to open, the newest one first unless counted. */
export async function waitForStreamRequest(supervisor: FakeSupervisor, count = 1): Promise<string> {
  await supervisor.inbox.waitUntil(
    `${count} desktop stream request(s)`,
    (messages) =>
      messages.filter((message) => message.type === "open_desktop_stream").length >= count,
  );
  const requests = supervisor.inbox.messages.filter(
    (message) => message.type === "open_desktop_stream",
  );
  const request = requests[count - 1];
  if (request?.type !== "open_desktop_stream") {
    throw new Error("No desktop stream was asked for.");
  }
  return request.streamId;
}
