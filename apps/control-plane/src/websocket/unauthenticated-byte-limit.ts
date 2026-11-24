import type { Duplex } from "node:stream";
import { maximumAccessTokenLength } from "@barrack/protocol";

/**
 * The most an `authenticate` frame can take on the wire: a token of the
 * longest length allowed, every character escaped as `\uXXXX` (six bytes, the
 * most JSON can make of one UTF-16 code unit), plus a kilobyte for the rest
 * of the message, the frame headers and a heartbeat pong or a close frame.
 */
export const largestUnauthenticatedClientInputInBytes = 6 * maximumAccessTokenLength + 1024;

export type UnauthenticatedByteLimit = {
  /** Stops counting, once the client has authenticated and owns the thread. */
  lift(): void;
};

/**
 * Counts what a client sends until it is authenticated, and destroys the
 * connection once that exceeds what authenticating needs. Without this, a
 * client that never authenticates could make the control plane buffer a
 * frame as large as the server's `maxPayload`, several megabytes, since `ws`
 * holds each frame whole before emitting it and takes `maxPayload` from the
 * server, the same for every connection; it offers no way to change it for
 * one. https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketserveroptions-callback
 *
 * The bytes are counted as they arrive, so `ws` holds at most this limit
 * plus the one read that crossed it. A frame that read completes is still
 * emitted, which is why `receiveMessages` also refuses, before parsing, any
 * frame larger than the client's phase allows.
 */
export function limitBytesUntilAuthenticated(
  socket: Duplex,
  onExceeded: () => void,
): UnauthenticatedByteLimit {
  let receivedBytes = 0;
  const countBytes = (chunk: Buffer): void => {
    receivedBytes += chunk.length;
    if (receivedBytes > largestUnauthenticatedClientInputInBytes) {
      socket.off("data", countBytes);
      onExceeded();
      socket.destroy();
    }
  };
  socket.on("data", countBytes);
  return { lift: () => socket.off("data", countBytes) };
}
