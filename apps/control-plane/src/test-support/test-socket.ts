import type { ParseResult } from "@barrack/protocol";
import { WebSocket } from "ws";
import { MessageInbox } from "./message-inbox.js";

export type CloseOutcome = { closeCode: number; reason: string };

export type UpgradeOutcome =
  | { opened: true }
  | { opened: false; statusCode: number; responseBody: string };

/**
 * Opens a WebSocket only to see whether the upgrade succeeds or is refused
 * with an HTTP status, which is how the control plane refuses peers. An
 * opened socket is closed again straight away.
 */
export async function attemptUpgrade(
  url: string,
  headers: Record<string, string>,
): Promise<UpgradeOutcome> {
  const socket = new WebSocket(url, { headers });
  const outcome = await upgradeOutcomeOf(socket);
  if (outcome.opened) {
    socket.close();
  }
  return outcome;
}

/**
 * Opens a test peer's WebSocket, failing if the upgrade is refused. Frames
 * are collected from the moment the socket exists, because the control plane
 * may send its first message in the same packet as the upgrade response.
 */
export async function openTestSocket<IncomingMessage>(
  url: string,
  headers: Record<string, string>,
  parseMessage: (frameText: string) => ParseResult<IncomingMessage>,
): Promise<TestSocket<IncomingMessage>> {
  const socket = new WebSocket(url, { headers });
  const testSocket = new TestSocket(socket, parseMessage);
  const outcome = await upgradeOutcomeOf(socket);
  if (!outcome.opened) {
    throw new Error(
      `Expected the upgrade to succeed, but it was refused with ${outcome.statusCode}: ${outcome.responseBody}`,
    );
  }
  return testSocket;
}

/**
 * A connected test peer's socket. Received frames are checked with the
 * protocol's own parser, so a test also fails if the control plane ever sends
 * something the protocol does not allow.
 */
export class TestSocket<IncomingMessage> {
  readonly inbox = new MessageInbox<IncomingMessage>();
  readonly closed: Promise<CloseOutcome>;
  readonly #socket: WebSocket;

  constructor(
    socket: WebSocket,
    parseMessage: (frameText: string) => ParseResult<IncomingMessage>,
  ) {
    this.#socket = socket;
    this.closed = new Promise((resolve) => {
      socket.once("close", (closeCode, reason) =>
        resolve({ closeCode, reason: reason.toString() }),
      );
    });
    socket.on("message", (frame) => {
      const parsed = parseMessage(String(frame));
      if (!parsed.ok) {
        throw new Error(`The control plane sent an invalid message: ${parsed.errorMessage}`);
      }
      this.inbox.add(parsed.value);
    });
  }

  sendMessage(message: unknown): void {
    this.sendRawFrame(JSON.stringify(message));
  }

  sendRawFrame(frameText: string): void {
    this.#socket.send(frameText);
  }

  async close(): Promise<void> {
    if (this.#socket.readyState !== WebSocket.CLOSED) {
      this.#socket.close();
    }
    await this.closed;
  }
}

function upgradeOutcomeOf(socket: WebSocket): Promise<UpgradeOutcome> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve({ opened: true }));
    socket.once("unexpected-response", (request, response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        request.destroy();
        resolve({ opened: false, statusCode: response.statusCode ?? 0, responseBody });
      });
    });
    socket.once("error", reject);
  });
}
