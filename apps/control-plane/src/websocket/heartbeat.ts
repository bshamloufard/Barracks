import type { WebSocket } from "ws";
import type { Logger } from "../logger.js";

/**
 * Pings the peer every interval and terminates the connection if the previous
 * ping went unanswered. Without this a peer that vanished without closing
 * (a laptop lid shut, a sandbox killed) would look connected until the
 * operating system's TCP timeout, which can be hours; for a supervisor that
 * means clients would be told an agent is there when it is not.
 */
export function keepConnectionAlive(
  socket: WebSocket,
  intervalInMilliseconds: number,
  logger: Logger,
): void {
  let isAwaitingPong = false;
  socket.on("pong", () => {
    isAwaitingPong = false;
  });
  const timer = setInterval(() => {
    if (isAwaitingPong) {
      logger.warn("Terminating a connection that stopped answering pings");
      socket.terminate();
      return;
    }
    isAwaitingPong = true;
    socket.ping();
  }, intervalInMilliseconds);
  socket.on("close", () => clearInterval(timer));
}
