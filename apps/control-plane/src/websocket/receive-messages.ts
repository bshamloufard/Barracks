import { closeCodes, type ParseResult } from "@barrack/protocol";
import type { RawData, WebSocket } from "ws";
import type { Logger } from "../logger.js";

/**
 * Checks every frame a peer sends against the protocol and hands on only
 * valid messages. A peer that sends anything else is disconnected with
 * `invalidMessage`, since a peer that has broken the protocol once cannot be
 * trusted to be in a state worth continuing with.
 */
export function receiveMessages<Message>(
  socket: WebSocket,
  parseMessage: (frameText: string) => ParseResult<Message>,
  handleMessage: (message: Message) => void,
  logger: Logger,
): void {
  socket.on("message", (frame: RawData, isBinary: boolean) => {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    if (isBinary) {
      closeForInvalidMessage(socket, "Binary frames are not part of the protocol", logger);
      return;
    }
    const parsed = parseMessage(decodeTextFrame(frame));
    if (!parsed.ok) {
      closeForInvalidMessage(socket, parsed.errorMessage, logger);
      return;
    }
    handleMessage(parsed.value);
  });
}

function closeForInvalidMessage(socket: WebSocket, reason: string, logger: Logger): void {
  logger.warn({ reason }, "Closing a connection that sent an invalid message");
  socket.close(closeCodes.invalidMessage, "Invalid message");
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
