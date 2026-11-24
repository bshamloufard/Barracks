import { pino } from "pino";
import type { ControlPlaneConfiguration } from "../configuration.js";
import { startControlPlaneServer } from "../control-plane-server.js";
import { ControllableThreadEventLog } from "./controllable-thread-event-log.js";
import {
  connectFakeSupervisor,
  connectTestClient,
  type FakeSupervisor,
  type TestClient,
} from "./test-peers.js";

export const testSupervisorToken = "test-supervisor-token-that-is-long-enough";
export const allowedTestOrigin = "http://localhost:5173";

export type TestControlPlaneOptions = {
  webClientDirectory?: string;
};

/**
 * A real control plane on an ephemeral port, with a log the test can pause,
 * and helpers that connect peers to it. `close` closes every peer it
 * connected and then the server, so no test leaves a handle open.
 */
export class TestControlPlane {
  readonly baseUrl: string;
  readonly httpBaseUrl: string;
  readonly threadEventLog: ControllableThreadEventLog;
  readonly #closeServer: () => Promise<void>;
  readonly #peers: Array<FakeSupervisor | TestClient> = [];

  private constructor(
    port: number,
    threadEventLog: ControllableThreadEventLog,
    closeServer: () => Promise<void>,
  ) {
    this.baseUrl = `ws://127.0.0.1:${port}`;
    this.httpBaseUrl = `http://127.0.0.1:${port}`;
    this.threadEventLog = threadEventLog;
    this.#closeServer = closeServer;
  }

  static async start(options: TestControlPlaneOptions = {}): Promise<TestControlPlane> {
    const threadEventLog = new ControllableThreadEventLog();
    const server = await startControlPlaneServer({
      configuration: testConfiguration(options),
      threadEventLog,
      logger: pino({ level: "silent" }),
    });
    return new TestControlPlane(server.port, threadEventLog, server.close);
  }

  async connectSupervisor(threadId: string): Promise<FakeSupervisor> {
    const supervisor = await connectFakeSupervisor(this.baseUrl, threadId, testSupervisorToken);
    this.#peers.push(supervisor);
    return supervisor;
  }

  async connectClient(threadId: string, lastSeenSequence = 0): Promise<TestClient> {
    const client = await connectTestClient(
      this.baseUrl,
      threadId,
      lastSeenSequence,
      allowedTestOrigin,
    );
    this.#peers.push(client);
    return client;
  }

  async close(): Promise<void> {
    await Promise.all(this.#peers.map((peer) => peer.close()));
    await this.#closeServer();
  }
}

function testConfiguration(options: TestControlPlaneOptions): ControlPlaneConfiguration {
  return {
    supervisorToken: testSupervisorToken,
    host: "127.0.0.1",
    port: 0,
    allowedClientOrigins: [allowedTestOrigin],
    webClientDirectory: options.webClientDirectory,
    logLevel: "silent",
    database: undefined,
  };
}
