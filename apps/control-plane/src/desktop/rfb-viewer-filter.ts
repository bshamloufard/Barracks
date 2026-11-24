/**
 * Reads what a desktop viewer sends to the sandbox's VNC server (RFB, RFC
 * 6143 section 7, and the extensions noVNC uses, as listed in
 * https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst), message
 * by message, however the viewer's frames split or join them, and decides
 * what reaches the sandbox:
 *
 * - keyboard, pointer, clipboard and screen-size messages only from the
 *   viewer that holds control; from any other they are dropped, so watching
 *   is enforced here rather than trusted to the viewer;
 * - the ClientInit's "shared" flag always on, so no viewer can disconnect
 *   the others;
 * - only the encodings on `allowedEncodings`, so a sandbox can never make a
 *   browser decode H.264 or anything else outside that list;
 * - nothing it does not recognise: an unknown message type, an unexpected
 *   protocol version or security type, or a message longer than allowed
 *   throws, and the viewer's connection is closed.
 *
 * The sandbox's VNC server offers only protocol 3.8 and security type None,
 * so that is all a viewer may answer with.
 */

const expectedProtocolVersion = "RFB 003.008\n";
const securityTypeNone = 1;

/** The most clipboard text a viewer may paste into the desktop at once. */
export const largestClipboardInBytes = 256 * 1024;

const largestEncodingCount = 128;

const clientMessageTypes = {
  setPixelFormat: 0,
  setEncodings: 2,
  framebufferUpdateRequest: 3,
  keyEvent: 4,
  pointerEvent: 5,
  clientCutText: 6,
  enableContinuousUpdates: 150,
  clientFence: 248,
  setDesktopSize: 251,
  qemuClientMessage: 255,
} as const;

/** Messages that act on the desktop, rather than ask what it looks like. */
const inputMessageTypes = new Set<number>([
  clientMessageTypes.keyEvent,
  clientMessageTypes.pointerEvent,
  clientMessageTypes.clientCutText,
  clientMessageTypes.setDesktopSize,
  clientMessageTypes.qemuClientMessage,
]);

/**
 * The encodings a viewer may ask the sandbox for: the compressed picture
 * encodings noVNC decodes in script (Tight, TightPNG, ZRLE), CopyRect and
 * Raw; and the pseudo-encodings for the cursor, quality and compression
 * levels, screen size changes, the end of an update, flow control (fences
 * and continuous updates), keyboard layouts and the extended clipboard.
 * Left out: H.264 (it would feed the sandbox's bytes to the browser's video
 * decoder), the desktop's name (nothing shows it), and extensions that
 * would change the length of messages this filter reads (extended mouse
 * buttons) or add message types it does not (xvp).
 */
export const allowedEncodings: ReadonlySet<number> = new Set([
  0, // Raw
  1, // CopyRect
  7, // Tight
  16, // ZRLE
  -260, // TightPNG
  ...range(-32, -23), // quality levels 0 to 9
  ...range(-256, -247), // compression levels 0 to 9
  -223, // DesktopSize
  -224, // LastRect
  -239, // Cursor
  -258, // QEMU extended key events
  -308, // ExtendedDesktopSize
  -312, // Fence
  -313, // ContinuousUpdates
  0xc0a1e5ce | 0, // ExtendedClipboard, as the signed 32-bit number the message carries
]);

type HandshakeStep = "version" | "security_type" | "client_init" | "done";

export type RfbViewerFilterOptions = {
  /** Whether this viewer holds control now; asked for every input message. */
  isInputAllowed: () => boolean;
  /** Called for each input message passed on, so the user's activity can be noted. */
  onInputForwarded: () => void;
};

export class RfbViewerFilter {
  readonly #options: RfbViewerFilterOptions;
  readonly #pending: Buffer[] = [];
  #pendingLength = 0;
  #handshakeStep: HandshakeStep = "version";
  #droppedInputCount = 0;

  constructor(options: RfbViewerFilterOptions) {
    this.#options = options;
  }

  /** How many input messages have been dropped so far, for the log. */
  get droppedInputCount(): number {
    return this.#droppedInputCount;
  }

  /**
   * Takes the next bytes the viewer sent and returns those to pass on: every
   * whole message so far, as allowed or rewritten. A message split across
   * frames waits here for its rest. Throws if the viewer breaks the rules.
   */
  accept(bytes: Buffer): Buffer {
    this.#pending.push(bytes);
    this.#pendingLength += bytes.length;
    const forwarded: Buffer[] = [];
    for (;;) {
      const buffered = this.#joinPending();
      const length = this.#nextMessageLength(buffered);
      if (length === undefined || buffered.length < length) {
        break;
      }
      this.#takePending(length);
      const passed = this.#review(buffered.subarray(0, length));
      if (passed !== undefined) {
        forwarded.push(passed);
      }
    }
    return Buffer.concat(forwarded);
  }

  #joinPending(): Buffer {
    if (this.#pending.length > 1) {
      const joined = Buffer.concat(this.#pending, this.#pendingLength);
      this.#pending.splice(0, this.#pending.length, joined);
    }
    return this.#pending[0] ?? Buffer.alloc(0);
  }

  #takePending(length: number): void {
    const rest = (this.#pending[0] ?? Buffer.alloc(0)).subarray(length);
    this.#pending.splice(0, this.#pending.length, ...(rest.length > 0 ? [rest] : []));
    this.#pendingLength = rest.length;
  }

  /** Undefined while too few bytes have come to know it. */
  #nextMessageLength(buffered: Buffer): number | undefined {
    switch (this.#handshakeStep) {
      case "version":
        return expectedProtocolVersion.length;
      case "security_type":
      case "client_init":
        return 1;
      case "done":
        return buffered.length === 0 ? undefined : clientMessageLength(buffered);
    }
  }

  #review(message: Buffer): Buffer | undefined {
    switch (this.#handshakeStep) {
      case "version":
        if (message.toString("latin1") !== expectedProtocolVersion) {
          throw new Error("The viewer asked for a protocol version other than RFB 3.8.");
        }
        this.#handshakeStep = "security_type";
        return message;
      case "security_type":
        if (message[0] !== securityTypeNone) {
          throw new Error("The viewer chose a security type the desktop does not offer.");
        }
        this.#handshakeStep = "client_init";
        return message;
      case "client_init":
        this.#handshakeStep = "done";
        return Buffer.from([1]);
      case "done":
        return this.#reviewClientMessage(message);
    }
  }

  #reviewClientMessage(message: Buffer): Buffer | undefined {
    const messageType = message.readUInt8(0);
    if (messageType === clientMessageTypes.setEncodings) {
      return keepAllowedEncodings(message);
    }
    if (!inputMessageTypes.has(messageType)) {
      return message;
    }
    if (!this.#options.isInputAllowed()) {
      this.#droppedInputCount += 1;
      return undefined;
    }
    this.#options.onInputForwarded();
    return message;
  }
}

/**
 * The length of the message at the start of `buffered`, or undefined until
 * enough of it has arrived to tell. Throws for a type it does not know or a
 * length beyond the limits.
 */
function clientMessageLength(buffered: Buffer): number | undefined {
  const messageType = buffered.readUInt8(0);
  switch (messageType) {
    case clientMessageTypes.setPixelFormat:
      return 20;
    case clientMessageTypes.setEncodings:
      return buffered.length < 4 ? undefined : 4 + 4 * encodingCount(buffered.readUInt16BE(2));
    case clientMessageTypes.framebufferUpdateRequest:
      return 10;
    case clientMessageTypes.keyEvent:
      return 8;
    case clientMessageTypes.pointerEvent:
      return 6;
    case clientMessageTypes.clientCutText:
      return buffered.length < 8 ? undefined : 8 + clipboardLength(buffered.readInt32BE(4));
    case clientMessageTypes.enableContinuousUpdates:
      return 10;
    case clientMessageTypes.clientFence:
      return buffered.length < 9 ? undefined : 9 + fencePayloadLength(buffered.readUInt8(8));
    case clientMessageTypes.setDesktopSize:
      return buffered.length < 8 ? undefined : 8 + 16 * buffered.readUInt8(6);
    case clientMessageTypes.qemuClientMessage:
      return buffered.length < 2 ? undefined : qemuMessageLength(buffered.readUInt8(1));
    default:
      throw new Error(`The viewer sent a message of unknown type ${messageType}.`);
  }
}

/** noVNC lists about thirty; far more is not a viewer worth serving. */
function encodingCount(count: number): number {
  if (count > largestEncodingCount) {
    throw new Error(`The viewer listed ${count} encodings; the limit is ${largestEncodingCount}.`);
  }
  return count;
}

/** A negative length is the extended clipboard's, whose absolute value is the payload's. */
function clipboardLength(declaredLength: number): number {
  const length = Math.abs(declaredLength);
  if (length > largestClipboardInBytes) {
    throw new Error(
      `The viewer sent ${length} bytes of clipboard; the limit is ${largestClipboardInBytes}.`,
    );
  }
  return length;
}

/** A fence carries at most 64 bytes of payload. */
function fencePayloadLength(length: number): number {
  if (length > 64) {
    throw new Error(`The viewer sent a fence with ${length} bytes of payload; the limit is 64.`);
  }
  return length;
}

/** Only the QEMU extended key event (subtype 0) is part of what a viewer may send. */
function qemuMessageLength(subtype: number): number {
  if (subtype !== 0) {
    throw new Error(`The viewer sent a QEMU message of unknown subtype ${subtype}.`);
  }
  return 12;
}

function keepAllowedEncodings(message: Buffer): Buffer {
  const requested = Array.from({ length: message.readUInt16BE(2) }, (_, index) =>
    message.readInt32BE(4 + 4 * index),
  );
  const kept = requested.filter((encoding) => allowedEncodings.has(encoding));
  const rewritten = Buffer.alloc(4 + 4 * kept.length);
  rewritten.writeUInt8(clientMessageTypes.setEncodings, 0);
  rewritten.writeUInt16BE(kept.length, 2);
  for (const [index, encoding] of kept.entries()) {
    rewritten.writeInt32BE(encoding, 4 + 4 * index);
  }
  return rewritten;
}

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}
