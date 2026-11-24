import { threadResponseSchema, threadsApiPath } from "@barrack/protocol";
import { FakeSandboxProvider } from "@barrack/sandbox-providers";
import { pino } from "pino";
import { startControlPlaneServer } from "../control-plane-server.js";
import { InMemoryThreadStore } from "../threads/in-memory-thread-store.js";
import type { SupervisorEnvironmentSettings } from "../threads/supervisor-environment.js";
import { ThreadCreator } from "../threads/thread-creator.js";
import type { ThreadStore } from "../threads/thread-store.js";
import { ControllableThreadEventLog } from "./controllable-thread-event-log.js";
import {
  connectFakeSupervisor,
  connectTestClient,
  type FakeSupervisor,
  type TestClient,
} from "./test-peers.js";

export const allowedTestOrigin = "http://localhost:5173";

export const testSupervisorEnvironment: SupervisorEnvironmentSettings = {
  controlPlaneUrlForSandboxes: "ws://control-plane.test:8787",
  agent: { harness: "fake" },
  modelCredentials: {},
};

export type TestControlPlaneOptions = {
  webClientDirectory?: string;
  /** Defaults to an in-memory store. */
  threadStore?: ThreadStore;
  /** Defaults to a fake provider, which runs no supervisor of its own. */
  sandboxProvider?: FakeSandboxProvider;
  supervisorEnvironment?: SupervisorEnvironmentSettings;
  /** Pauses between attempts to create a sandbox while the provider is unavailable; none by default. */
  retryDelaysInMilliseconds?: readonly number[];
};

/** A thread created through the API, with the token the provider was given for its supervisor. */
export type TestThread = { threadId: string; supervisorToken: string };

/**
 * A real control plane on an ephemeral port, with a fake sandbox provider
 * and a log the test can pause, and helpers that create threads and connect
 * peers to them. Everything it logs is kept, so a test can check what was
 * written. `close` closes every peer it connected and then the server, so no
 * test leaves a handle open.
 */
export class TestControlPlane {
  readonly baseUrl: string;
  readonly httpBaseUrl: string;
  readonly threadEventLog: ControllableThreadEventLog;
  readonly sandboxProvider: FakeSandboxProvider;
  readonly threadCreator: ThreadCreator;
  /** Every line the control plane logged, at every level. */
  readonly logLines: string[];
  readonly #closeServer: () => Promise<void>;
  readonly #peers: Array<FakeSupervisor | TestClient> = [];

  private constructor(fields: {
    port: number;
    threadEventLog: ControllableThreadEventLog;
    sandboxProvider: FakeSandboxProvider;
    threadCreator: ThreadCreator;
    logLines: string[];
    closeServer: () => Promise<void>;
  }) {
    this.baseUrl = `ws://127.0.0.1:${fields.port}`;
    this.httpBaseUrl = `http://127.0.0.1:${fields.port}`;
    this.threadEventLog = fields.threadEventLog;
    this.sandboxProvider = fields.sandboxProvider;
    this.threadCreator = fields.threadCreator;
    this.logLines = fields.logLines;
    this.#closeServer = fields.closeServer;
  }

  static async start(options: TestControlPlaneOptions = {}): Promise<TestControlPlane> {
    const logLines: string[] = [];
    const logger = pino({ level: "trace" }, { write: (line: string) => logLines.push(line) });
    const threadEventLog = new ControllableThreadEventLog();
    const threadStore = options.threadStore ?? new InMemoryThreadStore();
    const sandboxProvider = options.sandboxProvider ?? new FakeSandboxProvider();
    const threadCreator = new ThreadCreator({
      threadStore,
      sandboxProvider,
      sandboxProviderName: "fake",
      supervisorEnvironment: options.supervisorEnvironment ?? testSupervisorEnvironment,
      logger,
      retryDelaysInMilliseconds: options.retryDelaysInMilliseconds ?? [],
    });
    const server = await startControlPlaneServer({
      configuration: {
        host: "127.0.0.1",
        port: 0,
        allowedClientOrigins: [allowedTestOrigin],
        webClientDirectory: options.webClientDirectory,
      },
      threadEventLog,
      threadStore,
      threadCreator,
      logger,
    });
    return new TestControlPlane({
      port: server.port,
      threadEventLog,
      sandboxProvider,
      threadCreator,
      logLines,
      closeServer: server.close,
    });
  }

  /** Creates a thread through the API as a browser would, and waits until its sandbox is settled. */
  async createThread(): Promise<TestThread> {
    const response = await this.postThread();
    const body = threadResponseSchema.parse(await response.json());
    await this.threadCreator.whenSandboxCreationsSettle();
    const { threadId } = body.thread;
    return { threadId, supervisorToken: this.supervisorTokenGivenFor(threadId) };
  }

  /** Sends the request that creates a thread, with an allowed origin unless told otherwise. */
  postThread(
    headers: Record<string, string> = {
      Origin: allowedTestOrigin,
      "Content-Type": "application/json",
    },
    body = "{}",
  ): Promise<Response> {
    return fetch(`${this.httpBaseUrl}${threadsApiPath}`, { method: "POST", headers, body });
  }

  /** The token in the environment the provider was asked to give the thread's supervisor. */
  supervisorTokenGivenFor(threadId: string): string {
    const environments = this.sandboxProvider.calls.flatMap((call) =>
      call.operation === "create" && call.request.threadId === threadId
        ? [call.request.supervisorEnvironment]
        : [],
    );
    const { BARRACK_SUPERVISOR_TOKEN: token } = environments[0] ?? {};
    if (token === undefined) {
      throw new Error(`The provider was never given a supervisor token for ${threadId}.`);
    }
    return token;
  }

  async connectSupervisor(thread: TestThread): Promise<FakeSupervisor> {
    const supervisor = await connectFakeSupervisor(
      this.baseUrl,
      thread.threadId,
      thread.supervisorToken,
    );
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
