import { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  type DesktopFlowLimits,
  DesktopSplice,
  defaultDesktopFlowLimits,
  type SpliceEnding,
} from "./desktop-splice.js";
import { RfbViewerFilter } from "./rfb-viewer-filter.js";

/**
 * Real WebSockets over loopback: the "sandbox" and the "viewer" are clients
 * of a server whose two sockets the splice joins, as the control plane's
 * are, so backpressure travels through real TCP connections.
 */
type SplicedPair = {
  sandbox: WebSocket;
  viewer: WebSocket;
  viewerSide: WebSocket;
  splice: DesktopSplice;
  ended: Promise<SpliceEnding>;
};

let server: Server | undefined;
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    socket.terminate();
  }
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function startSplicedPair(limits: Partial<DesktopFlowLimits> = {}): Promise<SplicedPair> {
  const webSocketServer = new WebSocketServer({ noServer: true });
  const serverSides = new Map<string, Promise<WebSocket>>();
  const arrivals = new Map<string, (socket: WebSocket) => void>();
  for (const name of ["sandbox", "viewer"]) {
    serverSides.set(name, new Promise((resolve) => arrivals.set(name, resolve)));
  }
  server = createServer();
  server.on("upgrade", (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (serverSide) => {
      if (request.url === "/sandbox") {
        serverSide.pause();
      }
      openSockets.push(serverSide);
      arrivals.get(request.url?.slice(1) ?? "")?.(serverSide);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Not listening on a port.");
  }
  const connect = async (name: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/${name}`);
    openSockets.push(socket);
    await new Promise((resolve) => socket.once("open", resolve));
    return socket;
  };
  const sandbox = await connect("sandbox");
  const viewer = await connect("viewer");
  const streamSide = await serverSides.get("sandbox");
  const viewerSide = await serverSides.get("viewer");
  if (streamSide === undefined || viewerSide === undefined) {
    throw new Error("A side did not arrive.");
  }
  const { promise: ended, resolve: end } = Promise.withResolvers<SpliceEnding>();
  const splice = new DesktopSplice({
    viewerSocket: viewerSide,
    streamSocket: streamSide,
    filter: new RfbViewerFilter({ isInputAllowed: () => false, onInputForwarded: () => {} }),
    limits: { ...defaultDesktopFlowLimits, ...limits },
    logger: pino({ level: "silent" }),
    onEnd: end,
  });
  viewerSide.on("message", (data, isBinary) => {
    if (isBinary) {
      splice.forwardFromViewer(data as Buffer);
    }
  });
  return { sandbox, viewer, viewerSide, splice, ended };
}

/** Sends as fast as the sandbox's own socket takes it, for the given time; returns bytes sent. */
async function floodFromSandbox(sandbox: WebSocket, durationInMilliseconds: number) {
  const chunk = Buffer.alloc(64 * 1024, 7);
  let sentBytes = 0;
  const deadline = Date.now() + durationInMilliseconds;
  while (Date.now() < deadline && sandbox.readyState === WebSocket.OPEN) {
    if (sandbox.bufferedAmount < 1024 * 1024) {
      sandbox.send(chunk);
      sentBytes += chunk.length;
    } else {
      await sleep(5);
    }
    await sleep(0);
  }
  return sentBytes;
}

describe("a desktop splice", () => {
  it("relays the sandbox's bytes to the viewer, and the viewer's through the filter", async () => {
    const { sandbox, viewer } = await startSplicedPair();
    const atViewer: Buffer[] = [];
    const atSandbox: Buffer[] = [];
    viewer.on("message", (data) => atViewer.push(data as Buffer));
    sandbox.on("message", (data) => atSandbox.push(data as Buffer));

    sandbox.send(Buffer.from("RFB 003.008\n"));
    viewer.send(Buffer.from("RFB 003.008\n\u0001\u0000"));
    viewer.send(Buffer.from([5, 1, 0, 10, 0, 20]));
    await sleep(100);

    expect(Buffer.concat(atViewer).toString()).toBe("RFB 003.008\n");
    expect([...Buffer.concat(atSandbox)]).toEqual([...Buffer.from("RFB 003.008\n\u0001"), 1]);
  });

  it("stops reading the sandbox while the viewer is not reading, so nothing piles up", async () => {
    const { sandbox, viewer, viewerSide } = await startSplicedPair({
      stalledViewerTimeoutInMilliseconds: 60_000,
    });
    viewer.pause();
    let largestBacklog = 0;
    const watcher = setInterval(() => {
      largestBacklog = Math.max(largestBacklog, viewerSide.bufferedAmount);
    }, 5);

    const sentBytes = await floodFromSandbox(sandbox, 1_500);
    clearInterval(watcher);

    const { highWaterMarkInBytes } = defaultDesktopFlowLimits;
    expect(largestBacklog).toBeGreaterThan(0);
    expect(largestBacklog).toBeLessThanOrEqual(highWaterMarkInBytes + 64 * 1024 + 64);
    // Only what the kernel's socket buffers hold got through; unchecked, the
    // flood would be hundreds of megabytes.
    expect(sentBytes).toBeLessThan(64 * 1024 * 1024);
  });

  it("disconnects a viewer that stops reading for too long", async () => {
    const { sandbox, viewer, ended } = await startSplicedPair({
      stalledViewerTimeoutInMilliseconds: 300,
    });
    viewer.pause();

    void floodFromSandbox(sandbox, 3_000);

    expect(await ended).toBe("viewer_stalled");
  });

  it("holds the sandbox to its rate, however fast it sends", async () => {
    const bytesPerSecond = 128 * 1024;
    const { sandbox, viewer } = await startSplicedPair({
      sandboxToViewerBytesPerSecond: bytesPerSecond,
    });
    let receivedBytes = 0;
    const allReceived = new Promise<void>((resolve) =>
      viewer.on("message", (data) => {
        receivedBytes += (data as Buffer).length;
        if (receivedBytes >= 3 * bytesPerSecond) {
          resolve();
        }
      }),
    );
    const startedAt = Date.now();

    for (let chunk = 0; chunk < 24; chunk += 1) {
      sandbox.send(Buffer.alloc(16 * 1024));
    }
    await allReceived;

    // A second's worth passes at once, and so does one more read from the
    // socket (64 KiB) before reading stops; the rest, 192 KiB, takes 1.5 s.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
  });

  it("ends when the viewer breaks the VNC protocol, or the sandbox sends text", async () => {
    const brokenByViewer = await startSplicedPair();
    brokenByViewer.viewer.send(Buffer.from("SSH-2.0-OpenSSH\n"));
    const brokenBySandbox = await startSplicedPair();
    brokenBySandbox.sandbox.send("not VNC data");

    expect(await brokenByViewer.ended).toBe("viewer_broke_protocol");
    expect(await brokenBySandbox.ended).toBe("stream_broke_protocol");
  });

  it("ends when either side goes", async () => {
    const viewerGone = await startSplicedPair();
    viewerGone.viewer.close();
    const sandboxGone = await startSplicedPair();
    sandboxGone.sandbox.close();

    expect(await viewerGone.ended).toBe("viewer_closed");
    expect(await sandboxGone.ended).toBe("stream_closed");
  });
});
