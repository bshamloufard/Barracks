import { parseSupervisorEndpointPath } from "@barrack/protocol";
import { WebSocketServer } from "ws";

/**
 * Stands in for the control plane where a provider test only needs to know
 * that a sandbox's supervisor started and connected out: it accepts every
 * supervisor connection, holds it open, and counts them per thread. A
 * supervisor connects once each time it starts, so a second connection after
 * a stop and start proves the supervisor was launched again.
 */
export class SupervisorConnectionRecorder {
  readonly #server: WebSocketServer;
  readonly #connectionCounts = new Map<string, number>();
  readonly #listeners = new Set<() => void>();

  private constructor(server: WebSocketServer) {
    this.#server = server;
    server.on("connection", (_socket, request) => {
      const endpoint = parseSupervisorEndpointPath(request.url ?? "");
      if (!endpoint.ok) {
        return;
      }
      const { threadId } = endpoint.value;
      this.#connectionCounts.set(threadId, (this.#connectionCounts.get(threadId) ?? 0) + 1);
      for (const listener of this.#listeners) {
        listener();
      }
    });
  }

  static async listen(host: string): Promise<SupervisorConnectionRecorder> {
    const server = new WebSocketServer({ host, port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    return new SupervisorConnectionRecorder(server);
  }

  get port(): number {
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("The recorder is not listening on a TCP port.");
    }
    return address.port;
  }

  waitForConnections(
    threadId: string,
    connectionCount: number,
    timeoutInMilliseconds: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if ((this.#connectionCounts.get(threadId) ?? 0) >= connectionCount) {
          finish();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(
          new Error(
            `The supervisor of ${threadId} connected ${this.#connectionCounts.get(threadId) ?? 0} times, not ${connectionCount}.`,
          ),
        );
      }, timeoutInMilliseconds);
      const finish = (): void => {
        clearTimeout(timer);
        this.#listeners.delete(check);
      };
      this.#listeners.add(check);
      check();
    });
  }

  async close(): Promise<void> {
    for (const client of this.#server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
