import { closeCodes, type ParseResult } from "@barrack/protocol";
import type { RawData, WebSocket } from "ws";
import type { Logger } from "../logger.js";

export type ReceiveOptions = {
  /**
   * The largest frame, in bytes, worth parsing now; a larger one is refused
   * unread. The server's `maxPayload` already bounds every frame, so this
   * is for peers allowed less for a while, such as a client that has not
   * yet authenticated. Unlimited when absent.
   */
  largestFrameInBytes?: () => number;
};

/**
 * Checks every frame a peer sends against the protocol and hands on only
 * valid messages, each with the length of its frame's text. A peer that sends anything else is disconnected with
 * `invalidMessage`, since a peer that has broken the protocol once cannot be
 * trusted to be in a state worth continuing with.
 */
export function receiveMessages<Message>(
  socket: WebSocket,
  parseMessage: (frameText: string) => ParseResult<Message>,
  handleMessage: (message: Message, frameLength: number) => void,
  logger: Logger,
  options: ReceiveOptions = {},
): void {
  socket.on("message", (frame: RawData, isBinary: boolean) => {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    if (isBinary) {
      closeForInvalidMessage(socket, "Binary frames are not part of the protocol", logger);
      return;
    }
    const largestFrameInBytes = options.largestFrameInBytes?.() ?? Number.POSITIVE_INFINITY;
    if (byteLengthOf(frame) > largestFrameInBytes) {
      closeForInvalidMessage(socket, "A frame larger than any message allowed now", logger);
      return;
    }
    const frameText = decodeTextFrame(frame);
    const parsed = parseMessage(frameText);
    if (!parsed.ok) {
      closeForInvalidMessage(socket, parsed.errorMessage, logger);
      return;
    }
    handleMessage(parsed.value, frameText.length);
  });
}

function closeForInvalidMessage(socket: WebSocket, reason: string, logger: Logger): void {
  logger.warn({ reason }, "Closing a connection that sent an invalid message");
  socket.close(closeCodes.invalidMessage, "Invalid message");
}

function byteLengthOf(frame: RawData): number {
  if (Array.isArray(frame)) {
    return frame.reduce((total, fragment) => total + fragment.length, 0);
  }
  return frame.byteLength;
}

function decodeTextFrame(frame: RawData): string {
  if (Array.isArray(frame)) {
    return Buffer.concat(frame).toString("utf8");
  }
  if (frame instanceof ArrayBuffer) {
    return Buffer.from(frame).toString("utf8");
  }
  return frame.toString("utf8");
}
