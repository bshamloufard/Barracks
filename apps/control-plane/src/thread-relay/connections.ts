import type {
  ControlPlaneToClientMessage,
  ControlPlaneToSupervisorMessage,
} from "@barrack/protocol";

/**
 * How a thread relay talks to the peers attached to it. The relay decides
 * what to send and in what order; the WebSocket layer implements these and
 * deals with sockets, backpressure and closing.
 */

export interface SupervisorConnection {
  /**
   * Returns whether the socket accepted the message, which it does not once
   * it is closing. Acceptance is not delivery: a half-open connection accepts
   * messages that never arrive, which only acknowledged delivery can detect.
   */
  send(message: ControlPlaneToSupervisorMessage): boolean;
  close(closeCode: number, reason: string): void;
}

export interface ClientConnection {
  readonly isOpen: boolean;

  /**
   * Sends live traffic. A client that has fallen too far behind is
   * disconnected instead, so one slow viewer never holds up the others; it
   * reconnects with its last seen sequence and catches up from the log.
   */
  send(message: ControlPlaneToClientMessage): void;

  /**
   * Sends one message of a replay and resolves once it has been handed to the
   * network, so a long replay is paced by how fast the client reads rather
   * than piling up in memory and tripping the slow-client limit.
   */
  sendAndWaitUntilWritten(message: ControlPlaneToClientMessage): Promise<void>;
}
