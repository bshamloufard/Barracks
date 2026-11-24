import type {
  ControlPlaneToClientMessage,
  ControlPlaneToSupervisorMessage,
} from "@barrack/protocol";
import type { ClientConnection, SupervisorConnection } from "../thread-relay/connections.js";
import { MessageInbox } from "./message-inbox.js";

export type ClosingRequest = { closeCode: number; reason: string };

/**
 * Stand-ins for the WebSocket connections a thread relay talks to, with no
 * socket behind them. A test holding one of these calls the relay directly,
 * so it decides exactly which messages are waiting in the relay's queue at
 * any moment, which a real socket cannot promise.
 */

export class FakeSupervisorConnection implements SupervisorConnection {
  readonly inbox = new MessageInbox<ControlPlaneToSupervisorMessage>();
  closingRequest: ClosingRequest | undefined;

  send(message: ControlPlaneToSupervisorMessage): void {
    this.inbox.add(message);
  }

  close(closeCode: number, reason: string): void {
    this.closingRequest = { closeCode, reason };
  }
}

export class FakeClientConnection implements ClientConnection {
  readonly inbox = new MessageInbox<ControlPlaneToClientMessage>();
  readonly isOpen = true;

  send(message: ControlPlaneToClientMessage): void {
    this.inbox.add(message);
  }

  async sendAndWaitUntilWritten(message: ControlPlaneToClientMessage): Promise<void> {
    this.inbox.add(message);
  }
}

/**
 * Resolves once every promise chain started so far has run to completion.
 * That holds for a relay driven by fake connections and an in-memory log,
 * because none of them waits on a timer or on I/O, and Node runs every
 * pending promise callback before it runs the next `setImmediate` callback.
 */
export function allPendingWorkSettled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
