import { chmod, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { repositoryRoot, tsxLoaderUrl } from "./service-process.js";

/**
 * A desktop for a local-process sandbox that draws as the sandbox image's
 * Xvnc does, without an X server: a VNC server (RFB 3.8, security None,
 * RFC 6143) on the loopback port the supervisor gives it, which answers a
 * viewer's first update request with the whole screen as one Tight JPEG
 * rectangle (TigerVNC's usual encoding) and a cursor (the Cursor
 * pseudo-encoding). Those are the two things noVNC draws through `data:`
 * images, so a browser test sees the viewer's drawing under the page's
 * Content-Security-Policy. It ignores input, as a desktop being watched
 * gets none, and ends when its standard input closes, which is how the
 * supervisor stops a desktop.
 */

export const fakeDesktopSize = { width: 640, height: 400 } as const;

const protocolVersion = "RFB 003.008\n";
const securityTypeNone = 1;
const encodingTight = 7;
const pseudoEncodingCursor = -239;
const tightJpegCompression = 0x90;
const cursorSize = 8;

/**
 * Writes the program the supervisor runs as the desktop command (it must be
 * one executable path) and returns its path. `jpegPath` is the screen's
 * picture, which the test makes, since nothing on the machine need encode
 * JPEG.
 */
export async function writeFakeDesktopCommand(
  directory: string,
  jpegPath: string,
): Promise<string> {
  const commandPath = path.join(directory, "fake-vnc-desktop");
  const entryPoint = path.join(
    repositoryRoot,
    "tests/end-to-end/src/support/fake-vnc-desktop-main.ts",
  );
  await writeFile(
    commandPath,
    `#!/bin/sh\nexec '${process.execPath}' --import '${tsxLoaderUrl}' '${entryPoint}' '${jpegPath}'\n`,
  );
  await chmod(commandPath, 0o755);
  return commandPath;
}

export function serveFakeVncDesktop(port: number, jpeg: Buffer): Promise<Server> {
  const server = createServer((socket) => new FakeVncSession(socket, jpeg));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

type Stage = "version" | "security" | "client-init" | "messages";

/** Lengths of the client messages a watching noVNC sends, from what of them has arrived. */
function clientMessageLength(bytes: Buffer): number | undefined {
  switch (bytes[0]) {
    case 0: // SetPixelFormat
      return 20;
    case 2: // SetEncodings
      return bytes.length < 4 ? undefined : 4 + 4 * bytes.readUInt16BE(2);
    case 3: // FramebufferUpdateRequest
      return 10;
    case 5: // PointerEvent, sent even by a watching viewer as the mouse moves
      return 6;
    default:
      throw new Error(`The fake desktop does not read client message type ${bytes[0]}.`);
  }
}

class FakeVncSession {
  readonly #socket: Socket;
  readonly #jpeg: Buffer;
  #stage: Stage = "version";
  #pending = Buffer.alloc(0);
  #hasSentScreen = false;

  constructor(socket: Socket, jpeg: Buffer) {
    this.#socket = socket;
    this.#jpeg = jpeg;
    // The supervisor's probe hangs up once it has read the greeting.
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => this.#receive(chunk));
    socket.write(protocolVersion, "latin1");
  }

  #receive(chunk: Buffer): void {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    try {
      while (this.#handleNext()) {
        // Each pass handles one whole message.
      }
    } catch {
      this.#socket.destroy();
    }
  }

  /** Handles the next whole message, if one has arrived, and says whether it did. */
  #handleNext(): boolean {
    const length = this.#nextLength();
    if (length === undefined || this.#pending.length < length) {
      return false;
    }
    const message = this.#pending.subarray(0, length);
    this.#pending = this.#pending.subarray(length);
    this.#handle(message);
    return true;
  }

  #nextLength(): number | undefined {
    if (this.#pending.length === 0) {
      return undefined;
    }
    switch (this.#stage) {
      case "version":
        return protocolVersion.length;
      case "security":
      case "client-init":
        return 1;
      case "messages":
        return clientMessageLength(this.#pending);
    }
  }

  #handle(message: Buffer): void {
    switch (this.#stage) {
      case "version":
        this.#socket.write(Buffer.from([1, securityTypeNone]));
        this.#stage = "security";
        return;
      case "security":
        this.#socket.write(Buffer.alloc(4)); // SecurityResult: OK
        this.#stage = "client-init";
        return;
      case "client-init":
        this.#socket.write(describeServerInit());
        this.#stage = "messages";
        return;
      case "messages":
        if (message[0] === 3 && !this.#hasSentScreen) {
          this.#hasSentScreen = true;
          this.#socket.write(describeScreenUpdate(this.#jpeg));
        }
    }
  }
}

/** The screen's size, a 32-bit true-colour pixel format, and its name. */
function describeServerInit(): Buffer {
  const name = Buffer.from("Barrack test desktop", "latin1");
  const header = Buffer.alloc(24);
  header.writeUInt16BE(fakeDesktopSize.width, 0);
  header.writeUInt16BE(fakeDesktopSize.height, 2);
  Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(header, 4);
  header.writeUInt32BE(name.length, 20);
  return Buffer.concat([header, name]);
}

function describeScreenUpdate(jpeg: Buffer): Buffer {
  const update = Buffer.from([0, 0, 0, 2]); // FramebufferUpdate with two rectangles
  const screen = describeRectangle(
    0,
    0,
    fakeDesktopSize.width,
    fakeDesktopSize.height,
    encodingTight,
  );
  const jpegData = Buffer.concat([
    Buffer.from([tightJpegCompression]),
    describeCompactLength(jpeg.length),
    jpeg,
  ]);
  // The hot spot in the corner; black pixels, every one shown.
  const cursor = describeRectangle(0, 0, cursorSize, cursorSize, pseudoEncodingCursor);
  const cursorPixels = Buffer.alloc(cursorSize * cursorSize * 4);
  const cursorMask = Buffer.alloc(Math.ceil(cursorSize / 8) * cursorSize, 0xff);
  return Buffer.concat([update, screen, jpegData, cursor, cursorPixels, cursorMask]);
}

function describeRectangle(x: number, y: number, width: number, height: number, encoding: number) {
  const rectangle = Buffer.alloc(12);
  rectangle.writeUInt16BE(x, 0);
  rectangle.writeUInt16BE(y, 2);
  rectangle.writeUInt16BE(width, 4);
  rectangle.writeUInt16BE(height, 6);
  rectangle.writeInt32BE(encoding, 8);
  return rectangle;
}

/** Tight's length: seven bits a byte, least significant first, at most three bytes. */
function describeCompactLength(length: number): Buffer {
  const bytes = [length & 0x7f];
  if (length > 0x7f) {
    bytes[0] = (bytes[0] ?? 0) | 0x80;
    bytes.push((length >> 7) & 0x7f);
    if (length > 0x3fff) {
      bytes[1] = (bytes[1] ?? 0) | 0x80;
      bytes.push((length >> 14) & 0xff);
    }
  }
  return Buffer.from(bytes);
}
