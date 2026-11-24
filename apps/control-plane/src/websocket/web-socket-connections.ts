import {
  type ControlPlaneToClientMessage,
  type ControlPlaneToSupervisorMessage,
  closeCodes,
  maximumFrameLength,
} from "@barrack/protocol";
import { WebSocket } from "ws";
import type { Logger } from "../logger.js";
import { standardCloseCodes } from "../standard-close-codes.js";
import type { ClientConnection, SupervisorConnection } from "../thread-relay/connections.js";

/**
 * How many bytes may wait in a client's send buffer before it counts as too
 * slow. Several maximum-size frames' worth, so one large tool output does not
 * trip it, while a client that has stopped reading is still dropped long
 * before it costs the server real memory.
 */
const slowClientSendBufferLimitInBytes = 4 * maximumFrameLength;

export class WebSocketClientConnection implements ClientConnection {
  readonly #socket: WebSocket;
  readonly #logger: Logger;

  constructor(socket: WebSocket, logger: Logger) {
    this.#socket = socket;
    this.#logger = logger;
  }

  get isOpen(): boolean {
    return this.#socket.readyState === WebSocket.OPEN;
  }

  send(message: ControlPlaneToClientMessage): void {
    if (!this.isOpen) {
      return;
    }
    if (this.#socket.bufferedAmount > slowClientSendBufferLimitInBytes) {
      this.#logger.warn(
        { bufferedBytes: this.#socket.bufferedAmount },
        "Disconnecting a client that is not reading fast enough",
      );
      this.#socket.close(
        closeCodes.clientTooSlow,
        "Not reading fast enough; reconnect to catch up",
      );
      return;
    }
    const frameText = this.#serializeWithinFrameLimit(message);
    if (frameText === undefined) {
      return;
    }
    this.#socket.send(frameText, (error) => this.#logSendFailure(error));
  }

  sendAndWaitUntilWritten(message: ControlPlaneToClientMessage): Promise<void> {
    return new Promise((resolve) => {
      const frameText = this.isOpen ? this.#serializeWithinFrameLimit(message) : undefined;
      if (frameText === undefined) {
        resolve();
        return;
      }
      // Resolving even on failure is deliberate: a failed write means the
      // socket is closing, which the caller checks for after the replay.
      this.#socket.send(frameText, (error) => {
        this.#logSendFailure(error);
        resolve();
      });
    });
  }

  close(closeCode: number, reason: string): void {
    this.#socket.close(closeCode, reason);
  }

  /**
   * The last line of the guarantee that every frame sent to a client is one
   * it accepts: the relay already refuses to record a thread event that would
   * not fit, and bounds the streamed text it coalesces, so only a stream
   * fragment a supervisor sent at the very limit can get here, re-encoded a
   * little longer. Fragments may be lost, so such a one is dropped. Anything
   * else must not silently go missing, so the client is disconnected instead.
   */
  #serializeWithinFrameLimit(message: ControlPlaneToClientMessage): string | undefined {
    const frameText = JSON.stringify(message);
    if (frameText.length <= maximumFrameLength) {
      return frameText;
    }
    const details = { messageType: message.type, frameLength: frameText.length };
    if (message.type === "stream_fragment") {
      this.#logger.warn(details, "Dropped a stream fragment too large to send to a client");
      return undefined;
    }
    this.#logger.error(details, "Disconnecting a client from a message too large to send it");
    this.#socket.close(standardCloseCodes.internalError, "A message was too large to send");
    return undefined;
  }

  #logSendFailure(error: Error | undefined): void {
    if (isWriteFailure(error)) {
      this.#logger.warn({ err: error }, "Could not send a message to a client");
    }
  }
}

export class WebSocketSupervisorConnection implements SupervisorConnection {
  readonly #socket: WebSocket;
  readonly #logger: Logger;

  constructor(socket: WebSocket, logger: Logger) {
    this.#socket = socket;
    this.#logger = logger;
  }

  send(message: ControlPlaneToSupervisorMessage): boolean {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      this.#logger.warn(
        { messageType: message.type },
        "Could not send a message to the supervisor because its connection is closing",
      );
      return false;
    }
    this.#socket.send(JSON.stringify(message), (error) => {
      if (isWriteFailure(error)) {
        this.#logger.warn(
          { err: error, messageType: message.type },
          "Could not send a message to the supervisor",
        );
      }
    });
    return true;
  }

  close(closeCode: number, reason: string): void {
    this.#socket.close(closeCode, reason);
  }
}

/**
 * ws reports a successful write by calling back with `null`, although its
 * type declarations promise `undefined`, so only a real error counts.
 */
function isWriteFailure(error: Error | undefined): error is Error {
  return error instanceof Error;
}
