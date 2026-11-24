import { createServer } from "node:http";
import {
  type ControlPlaneToSupervisorMessage,
  parseSupervisorToControlPlaneMessage,
  type SupervisorDesktopMessage,
  type SupervisorHello,
} from "@barrack/protocol";
import { type WebSocket, WebSocketServer } from "ws";

export type UpgradeRequest = { path: string; authorization: string | undefined };

export type TestControlPlaneOptions = {
  answersPings: boolean;
  /** Whether it confirms each agent event as soon as it arrives, as a healthy control plane does. */
  confirmsEvents: boolean;
};

/**
 * A minimal control plane for tests: it answers every hello with a welcome
 * (saying, unless told otherwise, that it has recorded none of the
 * supervisor's events), confirms agent events if asked to, records what
 * supervisors send, and lets a test refuse connections or answer from the
 * server side.
 */
export type TestControlPlane = {
  /** `ws://127.0.0.1:<port>`, as the supervisor is configured with it. */
  url: string;
  upgradeRequests: UpgradeRequest[];
  /** Server-side sockets, one per accepted connection. */
  connections: WebSocket[];
  /** The hello each connection opened with, in order. */
  hellos: SupervisorHello[];
  /** Every frame after the hellos, in order, but the desktop's reports. */
  receivedFrames: string[];
  /** The desktop's reports (`desktop-messages.ts`), kept apart since they come on every welcome. */
  desktopMessages: SupervisorDesktopMessage[];
  /** While set, upgrade requests are answered with this HTTP status instead. */
  refuseUpgradesWith(statusCode: number | undefined, body?: string): void;
  /** What the next welcomes say was recorded of the supervisor's events. */
  welcomeWithLastRecordedEventNumber(eventNumber: number): void;
  /** Sends a message on the newest connection. */
  send(message: ControlPlaneToSupervisorMessage): void;
  close(): Promise<void>;
};

export async function startTestControlPlane(
  options: Partial<TestControlPlaneOptions> = {},
): Promise<TestControlPlane> {
  const { answersPings = true, confirmsEvents = true } = options;
  const upgradeRequests: UpgradeRequest[] = [];
  const connections: WebSocket[] = [];
  const hellos: SupervisorHello[] = [];
  const receivedFrames: string[] = [];
  const desktopMessages: SupervisorDesktopMessage[] = [];
  let refusal: { statusCode: number; body: string } | undefined;
  let lastRecordedEventNumberForWelcome = 0;
  const webSocketServer = new WebSocketServer({ noServer: true, autoPong: answersPings });
  const httpServer = createServer();

  const answer = (connection: WebSocket, frame: string): void => {
    const parsed = parseSupervisorToControlPlaneMessage(frame);
    if (!parsed.ok) {
      receivedFrames.push(frame);
      return;
    }
    const message = parsed.value;
    if (message.type === "supervisor_hello") {
      hellos.push(message);
      connection.send(
        JSON.stringify({
          type: "supervisor_welcome",
          lastRecordedEventNumber: lastRecordedEventNumberForWelcome,
        }),
      );
      return;
    }
    if (message.type === "desktop_availability" || message.type === "desktop_stream_failed") {
      desktopMessages.push(message);
      return;
    }
    receivedFrames.push(frame);
    if (message.type === "agent_event" && confirmsEvents) {
      connection.send(
        JSON.stringify({ type: "agent_events_recorded", throughEventNumber: message.eventNumber }),
      );
    }
  };

  httpServer.on("upgrade", (request, socket, head) => {
    upgradeRequests.push({ path: request.url ?? "", authorization: request.headers.authorization });
    if (refusal !== undefined) {
      // Node leaves an upgraded socket without an error listener. The
      // supervisor may reset the connection as soon as it has read the
      // refusal, which is expected here and must not crash the test run.
      socket.on("error", () => {});
      socket.end(
        `HTTP/1.1 ${refusal.statusCode} Refused\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(refusal.body)}\r\n\r\n${refusal.body}`,
      );
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (connection) => {
      connections.push(connection);
      connection.on("message", (data) => answer(connection, data.toString()));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("The test control plane is not listening on a TCP port.");
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    upgradeRequests,
    connections,
    hellos,
    receivedFrames,
    desktopMessages,
    refuseUpgradesWith: (statusCode, body = "") => {
      refusal = statusCode === undefined ? undefined : { statusCode, body };
    },
    welcomeWithLastRecordedEventNumber: (eventNumber) => {
      lastRecordedEventNumberForWelcome = eventNumber;
    },
    send: (message) => {
      connections.at(-1)?.send(JSON.stringify(message));
    },
    close: async () => {
      for (const connection of connections) {
        connection.terminate();
      }
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
