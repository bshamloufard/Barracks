import {
  type ClientAuthenticationConfiguration,
  threadResponseSchema,
  threadsApiPath,
} from "@barrack/protocol";
import { FakeSandboxProvider } from "@barrack/sandbox-providers";
import type { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { pino } from "pino";
import { Authenticator } from "../authentication/authenticator.js";
import {
  DevelopmentSingleUserVerifier,
  developmentAccessToken,
} from "../authentication/development-single-user.js";
import { SupabaseAccessTokenVerifier } from "../authentication/supabase-access-token-verifier.js";
import type { UserAdmission } from "../authentication/user-admission.js";
import { startControlPlaneServer } from "../control-plane-server.js";
import type { Logger } from "../logger.js";
import { InMemoryThreadStore } from "../threads/in-memory-thread-store.js";
import type { SupervisorEnvironmentSettings } from "../threads/supervisor-environment.js";
import { ThreadCreator } from "../threads/thread-creator.js";
import type { ThreadStore } from "../threads/thread-store.js";
import { InMemoryUserStore } from "../users/in-memory-user-store.js";
import type { UserStore } from "../users/user-store.js";
import { ControllableThreadEventLog } from "./controllable-thread-event-log.js";
import {
  connectFakeSupervisor,
  connectTestClient,
  type FakeSupervisor,
  type FakeSupervisorOptions,
  type TestClient,
} from "./test-peers.js";

export const allowedTestOrigin = "http://localhost:5173";

export const testSupervisorEnvironment: SupervisorEnvironmentSettings = {
  controlPlaneUrlForSandboxes: "ws://control-plane.test:8787",
  agent: { harness: "fake" },
  modelCredentials: {},
  piSettings: {},
};

/**
 * - `development`: the development mode's one user, whose token the helpers
 *   below use unless given another. Most tests are about something else.
 * - `test-issuer`: real verification of tokens from a test identity issuer,
 *   through the same verifier as a Supabase project's, with no clock
 *   tolerance so tests of expiry need not wait. Admits anyone who can sign
 *   in unless told otherwise.
 */
export type TestAuthentication =
  | { kind: "development" }
  | {
      kind: "test-issuer";
      issuer: TestIdentityIssuer;
      admission?: UserAdmission;
      keySetCooldownInMilliseconds?: number;
    };

export type TestControlPlaneOptions = {
  webClientDirectory?: string;
  /** Defaults to an in-memory store. */
  threadStore?: ThreadStore;
  /** Defaults to an in-memory store. */
  userStore?: UserStore;
  /** Defaults to a fake provider, which runs no supervisor of its own. */
  sandboxProvider?: FakeSandboxProvider;
  supervisorEnvironment?: SupervisorEnvironmentSettings;
  /** Pauses between attempts to create a sandbox while the provider is unavailable; none by default. */
  retryDelaysInMilliseconds?: readonly number[];
  /** Development mode's one user unless said otherwise. */
  authentication?: TestAuthentication;
  clientAuthenticationTimeoutInMilliseconds?: number;
};

/** A thread created through the API, with the token the provider was given for its supervisor. */
export type TestThread = { threadId: string; supervisorToken: string };

/**
 * A real control plane on an ephemeral port, with a fake sandbox provider
 * and a log the test can pause, and helpers that create threads and connect
 * peers to them, as development mode's one user unless given another
 * user's access token. Everything it logs is kept, so a test can check what
 * was written. `close` closes every peer it connected and then the server,
 * so no test leaves a handle open.
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
    const authentication = createTestAuthentication(
      options.authentication ?? { kind: "development" },
      options.userStore ?? new InMemoryUserStore(),
      logger,
    );
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
      ...authentication,
      logger,
      ...(options.clientAuthenticationTimeoutInMilliseconds === undefined
        ? {}
        : {
            clientAuthenticationTimeoutInMilliseconds:
              options.clientAuthenticationTimeoutInMilliseconds,
          }),
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
  async createThread(accessToken = developmentAccessToken): Promise<TestThread> {
    const response = await this.postThread({ ...browserHeaders(accessToken) });
    if (response.status !== 201) {
      throw new Error(`Creating a thread answered ${response.status}: ${await response.text()}`);
    }
    const body = threadResponseSchema.parse(await response.json());
    await this.threadCreator.whenSandboxCreationsSettle();
    const { threadId } = body.thread;
    return { threadId, supervisorToken: this.supervisorTokenGivenFor(threadId) };
  }

  /** Sends the request that creates a thread, as development mode's user from an allowed origin unless told otherwise. */
  postThread(
    headers: Record<string, string> = browserHeaders(developmentAccessToken),
    body = "{}",
  ): Promise<Response> {
    return fetch(`${this.httpBaseUrl}${threadsApiPath}`, { method: "POST", headers, body });
  }

  /** A GET of an API path, with the access token if one is given. */
  getApi(
    path: string,
    accessToken: string | undefined = developmentAccessToken,
  ): Promise<Response> {
    const headers: Record<string, string> =
      accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` };
    return fetch(`${this.httpBaseUrl}${path}`, { headers });
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

  /**
   * Connects a fake supervisor and, unless told otherwise, says its hello
   * and waits for the welcome, so it is attached when this resolves.
   */
  async connectSupervisor(
    thread: TestThread,
    options: FakeSupervisorOptions & {
      sayHello?: boolean;
      userMessagesDeliveredThroughSequence?: number;
    } = {},
  ): Promise<FakeSupervisor> {
    const supervisor = await connectFakeSupervisor(
      this.baseUrl,
      thread.threadId,
      thread.supervisorToken,
      options,
    );
    this.#peers.push(supervisor);
    if (options.sayHello ?? true) {
      await supervisor.sayHello(options.userMessagesDeliveredThroughSequence);
    }
    return supervisor;
  }

  /** Connects a client authenticated with the token, development mode's user's by default. */
  connectClient(
    threadId: string,
    lastSeenSequence = 0,
    accessToken = developmentAccessToken,
  ): Promise<TestClient> {
    return this.#connectTestClient(threadId, lastSeenSequence, accessToken);
  }

  /** Opens a client's connection and sends nothing, so the test decides what comes first. */
  openUnauthenticatedClient(threadId: string, lastSeenSequence = 0): Promise<TestClient> {
    return this.#connectTestClient(threadId, lastSeenSequence, undefined);
  }

  async #connectTestClient(
    threadId: string,
    lastSeenSequence: number,
    accessToken: string | undefined,
  ): Promise<TestClient> {
    const client = await connectTestClient(
      this.baseUrl,
      threadId,
      lastSeenSequence,
      allowedTestOrigin,
      accessToken,
    );
    this.#peers.push(client);
    return client;
  }

  async close(): Promise<void> {
    await Promise.all(this.#peers.map((peer) => peer.close()));
    await this.#closeServer();
  }
}

/** What a browser on the allowed origin sends with a JSON request, as the user the token is for. */
export function browserHeaders(accessToken: string): Record<string, string> {
  return {
    Origin: allowedTestOrigin,
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

function createTestAuthentication(
  authentication: TestAuthentication,
  userStore: UserStore,
  logger: Logger,
): { authenticator: Authenticator; clientAuthentication: ClientAuthenticationConfiguration } {
  if (authentication.kind === "development") {
    return {
      authenticator: new Authenticator({
        verifier: new DevelopmentSingleUserVerifier(),
        admission: { kind: "anyone-who-can-sign-in" },
        userStore,
        logger,
      }),
      clientAuthentication: {
        method: "development-single-user",
        accessToken: developmentAccessToken,
      },
    };
  }
  const { issuer } = authentication;
  const admission: UserAdmission = authentication.admission ?? { kind: "anyone-who-can-sign-in" };
  const project = {
    url: issuer.supabaseUrl,
    publishableKey: "sb_publishable_test",
    issuer: issuer.issuer,
  };
  const verifier = new SupabaseAccessTokenVerifier({
    project,
    confirmEmailAddresses: admission.kind === "listed-email-addresses",
    clockToleranceInSeconds: 0,
    ...(authentication.keySetCooldownInMilliseconds === undefined
      ? {}
      : { keySetCooldownInMilliseconds: authentication.keySetCooldownInMilliseconds }),
  });
  return {
    authenticator: new Authenticator({ verifier, admission, userStore, logger }),
    clientAuthentication: {
      method: "supabase",
      supabaseUrl: project.url,
      supabasePublishableKey: project.publishableKey,
    },
  };
}
