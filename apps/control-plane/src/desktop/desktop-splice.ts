import type { RawData, WebSocket } from "ws";
import type { Logger } from "../logger.js";
import { ByteRateLimit } from "./byte-rate-limit.js";
import { rawDataBytes } from "./raw-data-bytes.js";
import type { RfbViewerFilter } from "./rfb-viewer-filter.js";

/**
 * Flow control is not optional: a relay that reads one side as fast as it
 * arrives and writes it to a slow other side buffers without limit (a
 * viewer that stopped reading grew a prototype relay to 957 MiB in four
 * seconds). VNC is mostly paced by the viewer's requests, but a viewer may
 * ask for many full frames at once, and continuous updates are pushed.
 */
export type DesktopFlowLimits = {
  /** Past this much waiting to be sent to one side, the other side is no longer read... */
  highWaterMarkInBytes: number;
  /** ...until it has drained below this. */
  lowWaterMarkInBytes: number;
  /** A viewer that has not drained below the high mark for this long is disconnected. */
  stalledViewerTimeoutInMilliseconds: number;
  /**
   * The most a sandbox may send one viewer, on average: a cost guard
   * against a runaway or hostile sandbox, well above what the desktop sends
   * at its 15 frames a second (0.6 to 3.5 MB/s of continuous full-screen
   * motion, measured), so it only throttles what nobody needs.
   */
  sandboxToViewerBytesPerSecond: number;
  /** What a viewer may send the sandbox, on average; input is a few kilobytes a second. */
  viewerToSandboxBytesPerSecond: number;
};

export const defaultDesktopFlowLimits: DesktopFlowLimits = {
  highWaterMarkInBytes: 1024 * 1024,
  lowWaterMarkInBytes: 256 * 1024,
  stalledViewerTimeoutInMilliseconds: 20_000,
  sandboxToViewerBytesPerSecond: 4 * 1024 * 1024,
  viewerToSandboxBytesPerSecond: 512 * 1024,
};

export type DesktopSpliceOptions = {
  viewerSocket: WebSocket;
  /** The sandbox's end, which arrives paused and is resumed here. */
  streamSocket: WebSocket;
  filter: RfbViewerFilter;
  limits: DesktopFlowLimits;
  logger: Logger;
  /** Called once, when either side ends or breaks the rules, with why. */
  onEnd: (reason: SpliceEnding) => void;
};

/**
 * - `viewer_closed`, `stream_closed`: one side went away;
 * - `viewer_broke_protocol`: the viewer sent something the filter refuses;
 * - `stream_broke_protocol`: the sandbox sent a text frame;
 * - `viewer_stalled`: the viewer stopped reading.
 */
export type SpliceEnding =
  | "viewer_closed"
  | "stream_closed"
  | "viewer_broke_protocol"
  | "stream_broke_protocol"
  | "viewer_stalled";

const stallCheckIntervalInMilliseconds = 1_000;

/**
 * Joins a viewer's connection to the sandbox's desktop stream, both ways,
 * with flow control on each: a side is no longer read (so TCP pushes back
 * to its sender, the supervisor or the browser) while the other side has
 * more than the high mark waiting, or while it is over its rate. What the
 * sandbox sends is passed on as it is; what the viewer sends goes through
 * the filter first. The session hands the viewer's binary frames to
 * `forwardFromViewer`, since its text frames are control messages.
 */
export class DesktopSplice {
  readonly #options: DesktopSpliceOptions;
  readonly #fromSandbox: PausableReading;
  readonly #fromViewer: PausableReading;
  readonly #sandboxRate: ByteRateLimit;
  readonly #viewerRate: ByteRateLimit;
  readonly #stallCheck: NodeJS.Timeout;
  #viewerStalledSince: number | undefined;
  #hasEnded = false;

  constructor(options: DesktopSpliceOptions) {
    this.#options = options;
    const { streamSocket, viewerSocket, limits } = options;
    this.#fromSandbox = new PausableReading(streamSocket);
    this.#fromViewer = new PausableReading(viewerSocket);
    this.#sandboxRate = new ByteRateLimit(limits.sandboxToViewerBytesPerSecond);
    this.#viewerRate = new ByteRateLimit(limits.viewerToSandboxBytesPerSecond);
    streamSocket.on("message", (data, isBinary) => this.#forwardFromSandbox(data, isBinary));
    streamSocket.on("close", () => this.end("stream_closed"));
    viewerSocket.on("close", () => this.end("viewer_closed"));
    this.#stallCheck = setInterval(() => this.#checkForStall(), stallCheckIntervalInMilliseconds);
    streamSocket.resume();
  }

  /** The viewer's VNC bytes, checked by the filter before any reach the sandbox. */
  forwardFromViewer(data: Buffer): void {
    if (this.#hasEnded) {
      return;
    }
    let forwarded: Buffer;
    try {
      forwarded = this.#options.filter.accept(data);
    } catch (error) {
      this.#options.logger.warn(
        { reason: error instanceof Error ? error.message : String(error) },
        "A desktop viewer broke the VNC protocol",
      );
      this.end("viewer_broke_protocol");
      return;
    }
    this.#holdForRate(this.#fromViewer, this.#viewerRate, data.length);
    if (forwarded.length === 0) {
      return;
    }
    const { streamSocket, limits } = this.#options;
    streamSocket.send(forwarded, { binary: true }, () => {
      if (streamSocket.bufferedAmount < limits.lowWaterMarkInBytes) {
        this.#fromViewer.release("backlog");
      }
    });
    if (streamSocket.bufferedAmount > limits.highWaterMarkInBytes) {
      this.#fromViewer.hold("backlog");
    }
  }

  /** Closes both sides once; the reason is reported to `onEnd`. */
  end(reason: SpliceEnding): void {
    if (this.#hasEnded) {
      return;
    }
    this.#hasEnded = true;
    clearInterval(this.#stallCheck);
    this.#fromSandbox.stop();
    this.#fromViewer.stop();
    this.#options.streamSocket.terminate();
    this.#options.onEnd(reason);
  }

  #forwardFromSandbox(data: RawData, isBinary: boolean): void {
    if (this.#hasEnded) {
      return;
    }
    if (!isBinary) {
      this.end("stream_broke_protocol");
      return;
    }
    const bytes = rawDataBytes(data);
    const { viewerSocket, limits } = this.#options;
    viewerSocket.send(bytes, { binary: true }, () => {
      if (viewerSocket.bufferedAmount < limits.lowWaterMarkInBytes) {
        this.#viewerStalledSince = undefined;
        this.#fromSandbox.release("backlog");
      }
    });
    if (viewerSocket.bufferedAmount > limits.highWaterMarkInBytes) {
      this.#viewerStalledSince ??= Date.now();
      this.#fromSandbox.hold("backlog");
    }
    this.#holdForRate(this.#fromSandbox, this.#sandboxRate, bytes.length);
  }

  /**
   * Counts the bytes, and stops reading while over the rate. Bytes already
   * read when reading stopped still arrive (`ws` emits every message of a
   * chunk it has read), so the pause lasts until all of them are paid for.
   */
  #holdForRate(reading: PausableReading, rateLimit: ByteRateLimit, byteCount: number): void {
    const delayInMilliseconds = rateLimit.take(byteCount);
    if (delayInMilliseconds === 0 || reading.isHeldFor("rate")) {
      return;
    }
    reading.hold("rate");
    const releaseWhenPaidFor = () => {
      const remainingDelay = rateLimit.take(0);
      if (remainingDelay === 0) {
        reading.release("rate");
        return;
      }
      setTimeout(releaseWhenPaidFor, remainingDelay).unref();
    };
    setTimeout(releaseWhenPaidFor, delayInMilliseconds).unref();
  }

  #checkForStall(): void {
    const stalledSince = this.#viewerStalledSince;
    const timeout = this.#options.limits.stalledViewerTimeoutInMilliseconds;
    if (stalledSince !== undefined && Date.now() - stalledSince > timeout) {
      this.#options.logger.warn("Disconnecting a desktop viewer that stopped reading");
      this.end("viewer_stalled");
    }
  }
}

/**
 * Reading from a socket, paused while any reason to hold it holds. `ws`
 * stops reading the TCP connection while paused, so the sender is pushed
 * back on by TCP itself.
 */
class PausableReading {
  readonly #socket: WebSocket;
  readonly #reasons = new Set<string>();
  #isStopped = false;

  constructor(socket: WebSocket) {
    this.#socket = socket;
  }

  isHeldFor(reason: string): boolean {
    return this.#reasons.has(reason);
  }

  hold(reason: string): void {
    this.#reasons.add(reason);
    this.#socket.pause();
  }

  release(reason: string): void {
    this.#reasons.delete(reason);
    if (this.#reasons.size === 0 && !this.#isStopped) {
      this.#socket.resume();
    }
  }

  stop(): void {
    this.#isStopped = true;
  }
}
