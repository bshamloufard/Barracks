import { connect, type Socket } from "node:net";
import { pipeline } from "node:stream";
import { buildDesktopStreamEndpointPath } from "@barrack/protocol";
import WebSocket, { createWebSocketStream } from "ws";
import type { Logger } from "../logger.js";

/**
 * As many streams as the control plane lets a thread have viewers; a
 * control plane asking for more is refused rather than obeyed.
 */
export const maximumOpenDesktopStreams = 4;

/**
 * The largest frame the control plane may send on a stream: one VNC client
 * message, the largest being a clipboard paste, which the control plane
 * already limits to less than this.
 */
const maximumIncomingFrameInBytes = 1024 * 1024;

const connectTimeoutInMilliseconds = 5_000;
const handshakeTimeoutInMilliseconds = 10_000;

export type DesktopStreamsSettings = {
  /** For example `ws://127.0.0.1:8787`, without a trailing slash. */
  controlPlaneUrl: string;
  threadId: string;
  supervisorToken: string;
  /** The loopback port of the sandbox's VNC server, the only place a stream ever leads. */
  vncPort: number;
  /** Tells the control plane a stream could not be opened, and why. */
  reportFailure: (streamId: string, reason: string) => void;
  logger: Logger;
};

/**
 * Opens the desktop streams the control plane asks for (see
 * `packages/protocol/src/desktop-messages.ts`): for each, a connection to
 * the sandbox's own VNC server and a second outbound WebSocket to the
 * control plane, with the thread's token, and the bytes of each piped into
 * the other. Where a stream leads is decided here, never by the request:
 * only the VNC server on loopback.
 *
 * Both directions go through Node's stream pipeline, which carries
 * backpressure: when the control plane stops reading (its viewer is slow),
 * this side stops reading the VNC server's socket, whose writes then block,
 * so nothing piles up here.
 */
export class DesktopStreams {
  readonly #settings: DesktopStreamsSettings;
  readonly #logger: Logger;
  readonly #openStreams = new Map<string, { vncSocket: Socket; webSocket?: WebSocket }>();
  #isClosed = false;

  constructor(settings: DesktopStreamsSettings) {
    this.#settings = settings;
    this.#logger = settings.logger.child({ component: "desktop-streams" });
  }

  get openStreamCount(): number {
    return this.#openStreams.size;
  }

  open(streamId: string): void {
    if (this.#isClosed) {
      return;
    }
    if (this.#openStreams.has(streamId)) {
      this.#logger.warn({ streamId }, "Ignoring a second request for a desktop stream");
      return;
    }
    if (this.#openStreams.size >= maximumOpenDesktopStreams) {
      this.#fail(streamId, `The sandbox already has ${maximumOpenDesktopStreams} desktop streams.`);
      return;
    }
    const vncSocket = connect(this.#settings.vncPort, "127.0.0.1");
    this.#openStreams.set(streamId, { vncSocket });
    vncSocket.setNoDelay(true);
    vncSocket.setTimeout(connectTimeoutInMilliseconds, () =>
      vncSocket.destroy(new Error("the desktop's VNC server did not accept the connection")),
    );
    vncSocket.once("connect", () => {
      vncSocket.setTimeout(0);
      this.#dial(streamId, vncSocket);
    });
    vncSocket.on("error", (error) => {
      if (this.#openStreams.get(streamId)?.webSocket === undefined) {
        this.#fail(streamId, `The desktop is not answering: ${error.message}.`);
      }
    });
  }

  /** Ends every stream; no more are opened. */
  closeAll(): void {
    this.#isClosed = true;
    for (const { vncSocket, webSocket } of this.#openStreams.values()) {
      webSocket?.terminate();
      vncSocket.destroy();
    }
    this.#openStreams.clear();
  }

  #dial(streamId: string, vncSocket: Socket): void {
    const { controlPlaneUrl, threadId, supervisorToken } = this.#settings;
    const url = `${controlPlaneUrl}${buildDesktopStreamEndpointPath({ threadId, streamId })}`;
    const webSocket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${supervisorToken}` },
      handshakeTimeout: handshakeTimeoutInMilliseconds,
      maxPayload: maximumIncomingFrameInBytes,
      // VNC data is compressed already.
      perMessageDeflate: false,
    });
    this.#openStreams.set(streamId, { vncSocket, webSocket });
    webSocket.once("unexpected-response", (_request, response) => {
      this.#fail(streamId, `The control plane refused the stream (HTTP ${response.statusCode}).`);
      webSocket.terminate();
    });
    webSocket.once("open", () => this.#splice(streamId, vncSocket, webSocket));
    webSocket.on("error", (error) => {
      this.#logger.warn({ err: error, streamId }, "A desktop stream failed");
      this.#end(streamId);
    });
    webSocket.once("close", () => this.#end(streamId));
  }

  #splice(streamId: string, vncSocket: Socket, webSocket: WebSocket): void {
    this.#logger.info({ streamId }, "Opened a desktop stream");
    const webSocketStream = createWebSocketStream(webSocket);
    const end = () => this.#end(streamId);
    pipeline(vncSocket, webSocketStream, end);
    pipeline(webSocketStream, vncSocket, end);
  }

  #fail(streamId: string, reason: string): void {
    this.#logger.warn({ streamId, reason }, "Could not open a desktop stream");
    this.#end(streamId);
    this.#settings.reportFailure(streamId, reason);
  }

  #end(streamId: string): void {
    const stream = this.#openStreams.get(streamId);
    if (stream === undefined) {
      return;
    }
    this.#openStreams.delete(streamId);
    stream.webSocket?.terminate();
    stream.vncSocket.destroy();
    this.#logger.info({ streamId }, "Closed a desktop stream");
  }
}
