import { createServer, type Server, type Socket } from "node:net";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { encodePng } from "./png-encoder.js";
import { shrinkFrame } from "./screen-geometry.js";
import { omittedScreenshotText, pruneOldScreenshots } from "./screenshot-pruning.js";
import { type Framebuffer, readDisplaySize, readFramebuffer } from "./vnc-screen-reader.js";

/** Blue, green, red, unused: the layout the reader asks the server for. */
function pixel(red: number, green: number, blue: number): number[] {
  return [blue, green, red, 0];
}

const red = pixel(255, 0, 0);
const green = pixel(0, 255, 0);
const blue = pixel(0, 0, 255);
const white = pixel(255, 255, 255);

/**
 * A VNC server that speaks just enough RFB 3.8 to hand over one 2x2 frame,
 * in two rectangles, with a bell before it, as a real server may.
 */
async function startFakeVncServer(): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => serveOneFrame(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The fake VNC server is not listening on a port.");
  }
  return { port: address.port, server };
}

function serveOneFrame(socket: Socket): void {
  socket.on("error", () => {});
  socket.write("RFB 003.008\n");
  let receivedLength = 0;
  // What the server sends once the client has sent this many bytes in all.
  const answers = new Map<number, Buffer[]>([
    // The client's version: offer one security type, None.
    [12, [Buffer.from([1, 1])]],
    // Its choice of None: security result OK.
    [13, [Buffer.from([0, 0, 0, 0])]],
    // Its client init: the server init, for a 2x2 display named "fake".
    [14, [serverInit(2, 2, "fake")]],
    // Its pixel format (20), encodings (8) and update request (10): a bell, then the frame.
    [
      14 + 38,
      [
        Buffer.from([2]),
        Buffer.from([0, 0, 0, 2]),
        rectangle(0, 0, 2, 1, [...red, ...green]),
        rectangle(0, 1, 2, 1, [...blue, ...white]),
      ],
    ],
  ]);
  socket.on("data", (chunk) => {
    const before = receivedLength;
    receivedLength += chunk.length;
    for (const [threshold, messages] of answers) {
      if (before < threshold && receivedLength >= threshold) {
        for (const message of messages) {
          socket.write(message);
        }
      }
    }
  });
}

function serverInit(width: number, height: number, desktopName: string): Buffer {
  const name = Buffer.from(desktopName);
  const header = Buffer.alloc(24);
  header.writeUInt16BE(width, 0);
  header.writeUInt16BE(height, 2);
  header.writeUInt32BE(name.length, 20);
  return Buffer.concat([header, name]);
}

function rectangle(left: number, top: number, width: number, height: number, pixels: number[]) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(left, 0);
  header.writeUInt16BE(top, 2);
  header.writeUInt16BE(width, 4);
  header.writeUInt16BE(height, 6);
  return Buffer.concat([header, Buffer.from(pixels)]);
}

/** Red, green and blue of every pixel of an unfiltered 8-bit RGB PNG, row by row. */
function decodeRgbPng(png: Buffer): { width: number; height: number; rows: number[][] } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idatStart = png.indexOf("IDAT") + 4;
  const idatLength = png.readUInt32BE(idatStart - 8);
  const scanlines = inflateSync(png.subarray(idatStart, idatStart + idatLength));
  const rowLength = 1 + width * 3;
  const rows = Array.from({ length: height }, (_, row) => [
    ...scanlines.subarray(row * rowLength + 1, (row + 1) * rowLength),
  ]);
  return { width, height, rows };
}

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("reading the screen", () => {
  it("reads the display's size and its whole frame from the VNC server", async () => {
    const fake = await startFakeVncServer();
    server = fake.server;

    expect(await readDisplaySize(fake.port)).toEqual({ width: 2, height: 2 });
    const frame = await readFramebuffer(fake.port);

    expect(frame).toMatchObject({ width: 2, height: 2 });
    expect([...frame.pixels]).toEqual([...red, ...green, ...blue, ...white]);
  });

  it("encodes the frame as a PNG with the same colours", async () => {
    const fake = await startFakeVncServer();
    server = fake.server;

    const decoded = decodeRgbPng(encodePng(await readFramebuffer(fake.port)));

    expect(decoded).toEqual({
      width: 2,
      height: 2,
      rows: [
        [255, 0, 0, 0, 255, 0],
        [0, 0, 255, 255, 255, 255],
      ],
    });
  });

  it("shrinks a frame by averaging each area", () => {
    const frame: Framebuffer = {
      width: 2,
      height: 2,
      pixels: Buffer.from([...red, ...green, ...blue, ...white]),
    };

    const shrunk = shrinkFrame(frame, { width: 1, height: 1 });

    expect([...shrunk.pixels]).toEqual([128, 128, 128, 0]);
  });
});

describe("pruneOldScreenshots", () => {
  const screenshot = { type: "image", data: "base64", mimeType: "image/png" };
  const computerResult = (index: number) => ({
    role: "toolResult",
    toolName: "computer",
    content: [{ type: "text", text: `step ${index}` }, screenshot],
  });

  it("leaves the context alone until more than a batch beyond those kept have piled up", () => {
    const messages = Array.from({ length: 6 }, (_, index) => computerResult(index));

    expect(pruneOldScreenshots(messages, "computer")).toBeUndefined();
  });

  it("replaces the oldest screenshots in whole batches, keeping the newest ones as images", () => {
    const messages = Array.from({ length: 7 }, (_, index) => computerResult(index));

    const pruned = pruneOldScreenshots(messages, "computer") ?? [];

    const images = pruned.map((message) => message.content[1]);
    expect(images.slice(0, 3)).toEqual(
      Array(3).fill({ type: "text", text: omittedScreenshotText }),
    );
    expect(images.slice(3)).toEqual(Array(4).fill(screenshot));
    expect(messages[0]?.content[1]).toBe(screenshot);
  });

  it("does not touch images other tools returned", () => {
    const otherTool = { role: "toolResult", toolName: "read", content: [screenshot] };
    const messages = [otherTool, ...Array.from({ length: 7 }, (_, index) => computerResult(index))];

    expect(pruneOldScreenshots(messages, "computer")?.[0]).toBe(otherTool);
  });
});
