import { connect, type Socket } from "node:net";

/**
 * Reads the screen from the sandbox's own VNC server, as one more VNC client
 * on loopback: the agent sees exactly what the user's viewer shows, cursor
 * included, and the sandbox needs no screenshot program. The protocol is
 * RFC 6143 (RFB 3.8), with security type None, which the sandbox's
 * loopback-only server offers, and the Raw encoding, the one every server
 * must support.
 */

export type DisplaySize = { width: number; height: number };

/**
 * One frame, four bytes a pixel in the order blue, green, red, unused: the
 * little-endian layout of the pixel format this client asks for.
 */
export type Framebuffer = DisplaySize & { pixels: Buffer };

export const bytesPerPixel = 4;

/** Larger than any display the sandbox runs; a server claiming more is not believed. */
const largestDisplayEdge = 8192;
const readTimeoutInMilliseconds = 10_000;
const protocolVersion = "RFB 003.008\n";
const securityTypeNone = 1;

const messageTypes = {
  framebufferUpdate: 0,
  bell: 2,
  serverCutText: 3,
} as const;

/** The display's size, from the server's greeting alone. */
export async function readDisplaySize(port: number): Promise<DisplaySize> {
  const session = await openSession(port);
  session.close();
  return session.displaySize;
}

/** The whole screen as it is now. */
export async function readFramebuffer(port: number): Promise<Framebuffer> {
  const session = await openSession(port);
  try {
    return await session.readWholeScreen();
  } finally {
    session.close();
  }
}

type Session = {
  displaySize: DisplaySize;
  readWholeScreen(): Promise<Framebuffer>;
  close(): void;
};

async function openSession(port: number): Promise<Session> {
  const socket = connect(port, "127.0.0.1");
  const reader = new SocketByteReader(socket);
  try {
    const displaySize = await shakeHands(socket, reader);
    return {
      displaySize,
      readWholeScreen: () => readWholeScreen(socket, reader, displaySize),
      close: () => socket.destroy(),
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** RFC 6143 sections 7.1 to 7.3: version, security, and initialisation. */
async function shakeHands(socket: Socket, reader: SocketByteReader): Promise<DisplaySize> {
  const serverVersion = (await reader.read(12)).toString("latin1");
  if (!serverVersion.startsWith("RFB ")) {
    throw new Error("The desktop's VNC server did not greet as a VNC server.");
  }
  socket.write(protocolVersion);
  const securityTypeCount = (await reader.read(1)).readUInt8(0);
  if (securityTypeCount === 0) {
    throw new Error("The desktop's VNC server refused the connection.");
  }
  const securityTypes = [...(await reader.read(securityTypeCount))];
  if (!securityTypes.includes(securityTypeNone)) {
    throw new Error("The desktop's VNC server asks for a password, which this tool does not have.");
  }
  socket.write(Buffer.from([securityTypeNone]));
  if ((await reader.read(4)).readUInt32BE(0) !== 0) {
    throw new Error("The desktop's VNC server refused the connection.");
  }
  // Shared: the user's viewers stay connected.
  socket.write(Buffer.from([1]));
  const serverInit = await reader.read(24);
  const displaySize = { width: serverInit.readUInt16BE(0), height: serverInit.readUInt16BE(2) };
  await reader.read(serverInit.readUInt32BE(20));
  if (!isPlausibleDisplay(displaySize)) {
    throw new Error(
      `The desktop's VNC server reports a ${displaySize.width}x${displaySize.height} display.`,
    );
  }
  return displaySize;
}

async function readWholeScreen(
  socket: Socket,
  reader: SocketByteReader,
  displaySize: DisplaySize,
): Promise<Framebuffer> {
  socket.write(setPixelFormatMessage());
  socket.write(setRawEncodingMessage());
  socket.write(fullFrameRequest(displaySize));
  const pixels = Buffer.alloc(displaySize.width * displaySize.height * bytesPerPixel);
  for (;;) {
    const messageType = (await reader.read(1)).readUInt8(0);
    if (messageType === messageTypes.framebufferUpdate) {
      await readRectangles(reader, displaySize, pixels);
      return { ...displaySize, pixels };
    }
    await skipOtherMessage(reader, messageType);
  }
}

/** A full, non-incremental update covers the screen, in as many rectangles as the server likes. */
async function readRectangles(
  reader: SocketByteReader,
  displaySize: DisplaySize,
  pixels: Buffer,
): Promise<void> {
  const header = await reader.read(3);
  const rectangleCount = header.readUInt16BE(1);
  for (let index = 0; index < rectangleCount; index += 1) {
    const rectangle = await reader.read(12);
    const left = rectangle.readUInt16BE(0);
    const top = rectangle.readUInt16BE(2);
    const width = rectangle.readUInt16BE(4);
    const height = rectangle.readUInt16BE(6);
    if (rectangle.readInt32BE(8) !== 0) {
      throw new Error("The desktop's VNC server sent an encoding it was not asked for.");
    }
    if (left + width > displaySize.width || top + height > displaySize.height) {
      throw new Error("The desktop's VNC server sent a rectangle outside the screen.");
    }
    const rowLength = width * bytesPerPixel;
    const rectanglePixels = await reader.read(rowLength * height);
    for (let row = 0; row < height; row += 1) {
      const target = ((top + row) * displaySize.width + left) * bytesPerPixel;
      rectanglePixels.copy(pixels, target, row * rowLength, (row + 1) * rowLength);
    }
  }
}

/** A bell, or the server's clipboard, may come before the frame; neither matters here. */
async function skipOtherMessage(reader: SocketByteReader, messageType: number): Promise<void> {
  if (messageType === messageTypes.bell) {
    return;
  }
  if (messageType === messageTypes.serverCutText) {
    const header = await reader.read(7);
    await reader.read(Math.abs(header.readInt32BE(3)));
    return;
  }
  throw new Error(`The desktop's VNC server sent message type ${messageType} unasked.`);
}

/**
 * 32 bits a pixel, 24 of colour, little-endian, true colour, red in bits 16
 * to 23, green 8 to 15, blue 0 to 7: blue, green, red, unused in memory.
 */
function setPixelFormatMessage(): Buffer {
  return Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
}

function setRawEncodingMessage(): Buffer {
  return Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]);
}

function fullFrameRequest(displaySize: DisplaySize): Buffer {
  const request = Buffer.alloc(10);
  request.writeUInt8(3, 0);
  request.writeUInt16BE(displaySize.width, 6);
  request.writeUInt16BE(displaySize.height, 8);
  return request;
}

function isPlausibleDisplay({ width, height }: DisplaySize): boolean {
  return width > 0 && height > 0 && width <= largestDisplayEdge && height <= largestDisplayEdge;
}

/** Hands out exactly as many bytes as asked for, as they arrive, or fails with the connection. */
class SocketByteReader {
  readonly #chunks: Buffer[] = [];
  #bufferedLength = 0;
  #waiting:
    | { length: number; resolve: (bytes: Buffer) => void; reject: (error: Error) => void }
    | undefined;
  #failure: Error | undefined;

  constructor(socket: Socket) {
    socket.setTimeout(readTimeoutInMilliseconds, () =>
      socket.destroy(new Error("The desktop's VNC server stopped answering.")),
    );
    socket.on("data", (chunk) => {
      this.#chunks.push(chunk);
      this.#bufferedLength += chunk.length;
      this.#settle();
    });
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () =>
      this.#fail(new Error("The desktop's VNC server closed the connection.")),
    );
  }

  read(length: number): Promise<Buffer> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
    this.#waiting = { length, resolve, reject };
    this.#settle();
    return promise;
  }

  #settle(): void {
    const waiting = this.#waiting;
    if (waiting === undefined || this.#bufferedLength < waiting.length) {
      return;
    }
    const joined = Buffer.concat(this.#chunks, this.#bufferedLength);
    const rest = joined.subarray(waiting.length);
    this.#chunks.length = 0;
    if (rest.length > 0) {
      this.#chunks.push(rest);
    }
    this.#bufferedLength = rest.length;
    this.#waiting = undefined;
    waiting.resolve(joined.subarray(0, waiting.length));
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    this.#waiting?.reject(this.#failure);
    this.#waiting = undefined;
  }
}
