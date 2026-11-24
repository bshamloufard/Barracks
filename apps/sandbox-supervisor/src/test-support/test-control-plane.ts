import { createServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";

export type UpgradeRequest = { path: string; authorization: string | undefined };

/**
 * A minimal control plane for tests: it records what supervisors send and
 * lets a test refuse connections or answer from the server side.
 */
export type TestControlPlane = {
  /** `ws://127.0.0.1:<port>`, as the supervisor is configured with it. */
  url: string;
  upgradeRequests: UpgradeRequest[];
  /** Server-side sockets, one per accepted connection. */
  connections: WebSocket[];
  receivedFrames: string[];
  /** While set, upgrade requests are answered with this HTTP status instead. */
  refuseUpgradesWith(statusCode: number | undefined): void;
  close(): Promise<void>;
};

export async function startTestControlPlane(
  options: { answersPings: boolean } = { answersPings: true },
): Promise<TestControlPlane> {
  const upgradeRequests: UpgradeRequest[] = [];
  const connections: WebSocket[] = [];
  const receivedFrames: string[] = [];
  let refusalStatusCode: number | undefined;
  const webSocketServer = new WebSocketServer({ noServer: true, autoPong: options.answersPings });
  const httpServer = createServer();
  httpServer.on("upgrade", (request, socket, head) => {
    upgradeRequests.push({ path: request.url ?? "", authorization: request.headers.authorization });
    if (refusalStatusCode !== undefined) {
      socket.end(
        `HTTP/1.1 ${refusalStatusCode} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (connection) => {
      connections.push(connection);
      connection.on("message", (data) => receivedFrames.push(data.toString()));
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
    receivedFrames,
    refuseUpgradesWith: (statusCode) => {
      refusalStatusCode = statusCode;
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
