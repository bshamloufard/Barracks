import {
  type ControlPlaneToClientMessage,
  maximumFrameLength,
  parseControlPlaneToClientMessage,
} from "@barrack/protocol";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { standardCloseCodes } from "../standard-close-codes.js";
import { MessageInbox } from "../test-support/message-inbox.js";
import { WebSocketClientConnection } from "./web-socket-connections.js";

/**
 * The relay never hands a client connection a message too large for a
 * frame; these tests hand it one directly, to check the last line of
 * defence on its own.
 */

type ConnectedPair = {
  connection: WebSocketClientConnection;
  inbox: MessageInbox<ControlPlaneToClientMessage>;
  closed: Promise<number>;
};

let server: WebSocketServer | undefined;

afterEach(async () => {
  for (const socket of server?.clients ?? []) {
    socket.terminate();
  }
  await new Promise((resolve) => server?.close(resolve));
});

async function connectPair(): Promise<ConnectedPair> {
  const listeningServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server = listeningServer;
  await new Promise((resolve) => listeningServer.once("listening", resolve));
  const address = listeningServer.address();
  if (address === null || typeof address === "string") {
    throw new Error(`Expected a TCP address, got ${String(address)}`);
  }
  const { port } = address;
  const serverSocket = new Promise<WebSocket>((resolve) =>
    listeningServer.once("connection", resolve),
  );
  const clientSocket = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 0 });
  const inbox = new MessageInbox<ControlPlaneToClientMessage>();
  clientSocket.on("message", (frame) => {
    const parsed = parseControlPlaneToClientMessage(String(frame));
    if (!parsed.ok) {
      throw new Error(`The connection sent an invalid message: ${parsed.errorMessage}`);
    }
    inbox.add(parsed.value);
  });
  const closed = new Promise<number>((resolve) => clientSocket.once("close", resolve));
  const connection = new WebSocketClientConnection(await serverSocket, pino({ level: "silent" }));
  return { connection, inbox, closed };
}

function streamFragmentWithText(text: string): ControlPlaneToClientMessage {
  return {
    type: "stream_fragment",
    fragment: {
      type: "assistant_text_fragment",
      messageId: "assistant-1",
      contentBlockIndex: 0,
      contentBlockType: "text",
      appendedText: text,
    },
  };
}

const status: ControlPlaneToClientMessage = {
  type: "supervisor_connection_status",
  isSupervisorConnected: true,
};

describe("a client's WebSocket connection", () => {
  it("drops a stream fragment too large for a frame and keeps the client connected", async () => {
    const { connection, inbox } = await connectPair();
    const fragmentLength = JSON.stringify(streamFragmentWithText("")).length;

    connection.send(streamFragmentWithText("x".repeat(maximumFrameLength - fragmentLength + 1)));
    connection.send(status);
    await inbox.waitFor(
      "the status sent after the fragment",
      (message) => message.type === status.type,
    );

    expect(inbox.messages).toEqual([status]);
    expect(connection.isOpen).toBe(true);
  });

  it("disconnects the client rather than leave out a thread event too large for a frame", async () => {
    const { connection, closed } = await connectPair();
    const recordedEvent: ControlPlaneToClientMessage = {
      type: "thread_event",
      sequence: 1,
      recordedAt: "2026-11-24T09:00:00.000Z",
      event: {
        type: "assistant_message",
        messageId: "assistant-1",
        content: [{ type: "text", text: "x".repeat(maximumFrameLength) }],
        endReason: "completed",
      },
    };

    await connection.sendAndWaitUntilWritten(recordedEvent);

    expect(await closed).toBe(standardCloseCodes.internalError);
  });
});
