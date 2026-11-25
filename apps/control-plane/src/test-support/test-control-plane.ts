import { randomBytes } from "node:crypto";
import {
  buildModelCredentialApiPath,
  threadResponseSchema,
  threadsApiPath,
} from "@barrack/protocol";
import { FakeSandboxProvider } from "@barrack/sandbox-providers";
import type { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { pino } from "pino";
import { Authenticator } from "../authentication/authenticator.js";
import type { ConfiguredAuthentication } from "../authentication/create-authenticator.js";
import {
  DevelopmentSingleUserVerifier,
  developmentAccessToken,
} from "../authentication/development-single-user.js";
import { SupabaseAccessTokenVerifier } from "../authentication/supabase-access-token-verifier.js";
import type { UserAdmission } from "../authentication/user-admission.js";
import { ChatGptPlanAccess } from "../chatgpt-plan/chatgpt-plan-access.js";
import { ChatGptPlanModels } from "../chatgpt-plan/chatgpt-plan-models.js";
import { openAiSignInIssuer } from "../chatgpt-plan/chatgpt-plan-settings.js";
import type { ChatGptPlanStore } from "../chatgpt-plan/chatgpt-plan-store.js";
import { ChatGptSignIn } from "../chatgpt-plan/chatgpt-sign-in.js";
import { ChatGptSignInClient } from "../chatgpt-plan/chatgpt-sign-in-client.js";
import { InMemoryChatGptPlanStore } from "../chatgpt-plan/in-memory-chatgpt-plan-store.js";
import { InMemoryOpenAiAccessAllowanceStore } from "../chatgpt-plan/in-memory-openai-access-allowance-store.js";
import type { OpenAiAccessAllowanceStore } from "../chatgpt-plan/openai-access-allowance-store.js";
import { OpenAiAccessAllowances } from "../chatgpt-plan/openai-access-allowances.js";
import { startControlPlaneServer } from "../control-plane-server.js";
import type { GithubConnectionStore } from "../github/github-connection-store.js";
import type { GithubSettings } from "../github/github-settings.js";
import { InMemoryGithubConnectionStore } from "../github/in-memory-github-connection-store.js";
import type { Logger } from "../logger.js";
import { CredentialKeyring } from "../model-access/credential-keyring.js";
import { InMemoryModelCredentialStore } from "../model-access/in-memory-model-credential-store.js";
import { ModelAccessChanges } from "../model-access/model-access-changes.js";
import type { ModelCredentialStore } from "../model-access/model-credential-store.js";
import { ModelCredentials } from "../model-access/model-credentials.js";
import { OwnerModelAccess } from "../model-access/owner-model-access.js";
import { assembleModelProxy } from "../model-proxy/assemble-model-proxy.js";
import { InMemoryModelProxyTokenStore } from "../model-proxy/in-memory-model-proxy-token-store.js";
import { InMemoryModelSwitchAllowanceStore } from "../model-proxy/in-memory-model-switch-allowance-store.js";
import type { ModelProxy } from "../model-proxy/model-proxy.js";
import type { ModelProxyLimits } from "../model-proxy/model-proxy-limits.js";
import type { ModelProxyTokenStore } from "../model-proxy/model-proxy-token-store.js";
import { ModelProxyTokens } from "../model-proxy/model-proxy-tokens.js";
import type { ModelSwitchAllowanceStore } from "../model-proxy/model-switch-allowance-store.js";
import { ModelSwitchAllowances } from "../model-proxy/model-switch-allowances.js";
import { InMemoryModelUsageStore } from "../model-usage/in-memory-model-usage-store.js";
import { ModelUsage, type ModelUsageCapSettings } from "../model-usage/model-usage.js";
import type { ModelUsageStore } from "../model-usage/model-usage-store.js";
import type { GitChildLimits } from "../publication/git-child-limits.js";
import {
  assembleRepositoryServices,
  type RepositoryServices,
} from "../repositories/assemble-repository-services.js";
import type { CredentialRequestLimits } from "../repositories/repository-credentials.js";
import type { ThreadRepositoryStore } from "../repositories/thread-repository-store.js";
import {
  assembleThreadServices,
  type ThreadServices,
} from "../sandbox-lifecycle/assemble-thread-services.js";
import type { Clock, SandboxLifecycleSettings } from "../sandbox-lifecycle/lifecycle-settings.js";
import { InMemoryThreadStore } from "../threads/in-memory-thread-store.js";
import type { SupervisorEnvironmentSettings } from "../threads/supervisor-environment.js";
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

/** No GitHub App, and only https:// repositories: what an installation that set nothing up has. */
export const testGithubSettings: GithubSettings = {
  app: undefined,
  webUrl: "https://github.com",
  apiUrl: "https://api.github.com",
  allowPlainHttp: false,
};

export const testSupervisorEnvironment: SupervisorEnvironmentSettings = {
  controlPlaneUrlForSandboxes: "ws://control-plane.test:8787",
  agent: { harness: "fake" },
  piSettings: {},
};

/**
 * Generous, so tests about something else never meet the limit. The sweeps
 * are not started by the test control plane; a test runs them itself
 * (`threadServices.reconciler`, `threadServices.idleShutdown`).
 */
export const testLifecycleSettings: SandboxLifecycleSettings = {
  idlePeriodInMilliseconds: 10 * 60_000,
  admission: { maximumPerUser: 100, maximumInInstallation: undefined },
  checkIntervalInMilliseconds: 30_000,
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
  /** Required with a thread store that is not the in-memory one, whose own it is by default. */
  threadRepositoryStore?: ThreadRepositoryStore;
  /** Defaults to an in-memory store. */
  githubConnectionStore?: GithubConnectionStore;
  /** Defaults to an in-memory store, sealing under a key of its own. */
  modelCredentialStore?: ModelCredentialStore;
  /** Defaults to an in-memory store. */
  modelProxyTokenStore?: ModelProxyTokenStore;
  modelSwitchAllowanceStore?: ModelSwitchAllowanceStore;
  openAiAccessAllowanceStore?: OpenAiAccessAllowanceStore;
  /** Defaults to an in-memory store. */
  modelUsageStore?: ModelUsageStore;
  /** No cap by default, over a day. */
  modelUsageCap?: Partial<ModelUsageCapSettings>;
  /** Where the model proxy sends every provider's requests; the providers' own hosts by default. */
  modelProxyUpstreamOrigin?: string;
  /**
   * Not offered by default. `signInIssuer` offers ChatGPT plans, signing in
   * at that stand-in for OpenAI's sign-in, unless `isOffered` is false (an
   * installation that turned them off, where a sign-in kept from before
   * is still revoked there); their models are listed where the model proxy
   * sends OpenAI's requests.
   */
  chatGptPlan?: { signInIssuer: string; isOffered?: boolean };
  /** Defaults to an in-memory store, sealing under a key of its own. */
  chatGptPlanStore?: ChatGptPlanStore;
  /** Replaces some of the proxy's default limits. */
  modelProxyLimits?: Partial<ModelProxyLimits>;
  /** Whether threads must have a model, as with the real agent; not by default, as with the fake one. */
  isModelRequired?: boolean;
  /** No GitHub App by default (`testGithubSettings`). */
  github?: GithubSettings;
  credentialRequestLimits?: CredentialRequestLimits;
  maximumBundleSizeInBytes?: number;
  /** What each Git process publishing may use; the production limits by default. */
  gitChildLimits?: GitChildLimits;
  /** Defaults to an empty controllable log. */
  threadEventLog?: ControllableThreadEventLog;
  /** Defaults to a fake provider, which runs no supervisor of its own. */
  sandboxProvider?: FakeSandboxProvider;
  supervisorEnvironment?: SupervisorEnvironmentSettings;
  /** Pauses between attempts while the provider is unavailable; none by default. */
  retryDelaysInMilliseconds?: readonly number[];
  /** Replaces some of `testLifecycleSettings`. */
  lifecycleSettings?: Partial<SandboxLifecycleSettings>;
  /** The real time unless a test controls it. */
  clock?: Clock;
  /**
   * How long a stop waits for an interrupted run to end; short by default,
   * since a fake supervisor answers only when told to.
   */
  interruptGracePeriodInMilliseconds?: number;
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
  readonly threadStore: ThreadStore;
  readonly sandboxProvider: FakeSandboxProvider;
  readonly threadServices: ThreadServices;
  readonly repositoryServices: RepositoryServices;
  readonly modelCredentials: ModelCredentials;
  readonly chatGptPlan: ChatGptPlanAccess;
  readonly modelUsage: ModelUsage;
  readonly modelProxyTokens: ModelProxyTokens;
  /** The model proxy itself, whose activity a test can read. */
  readonly modelProxy: ModelProxy;
  /** Every line the control plane logged, at every level. */
  readonly logLines: string[];
  readonly #closeServer: () => Promise<void>;
  readonly #peers: Array<FakeSupervisor | TestClient> = [];

  private constructor(fields: {
    port: number;
    threadEventLog: ControllableThreadEventLog;
    threadStore: ThreadStore;
    sandboxProvider: FakeSandboxProvider;
    threadServices: ThreadServices;
    repositoryServices: RepositoryServices;
    modelCredentials: ModelCredentials;
    chatGptPlan: ChatGptPlanAccess;
    modelUsage: ModelUsage;
    modelProxyTokens: ModelProxyTokens;
    modelProxy: ModelProxy;
    logLines: string[];
    closeServer: () => Promise<void>;
  }) {
    this.baseUrl = `ws://127.0.0.1:${fields.port}`;
    this.httpBaseUrl = `http://127.0.0.1:${fields.port}`;
    this.threadEventLog = fields.threadEventLog;
    this.threadStore = fields.threadStore;
    this.sandboxProvider = fields.sandboxProvider;
    this.threadServices = fields.threadServices;
    this.repositoryServices = fields.repositoryServices;
    this.modelCredentials = fields.modelCredentials;
    this.chatGptPlan = fields.chatGptPlan;
    this.modelUsage = fields.modelUsage;
    this.modelProxyTokens = fields.modelProxyTokens;
    this.modelProxy = fields.modelProxy;
    this.logLines = fields.logLines;
    this.#closeServer = fields.closeServer;
  }

  static async start(options: TestControlPlaneOptions = {}): Promise<TestControlPlane> {
    const logLines: string[] = [];
    const logger = pino({ level: "trace" }, { write: (line: string) => logLines.push(line) });
    const threadEventLog = options.threadEventLog ?? new ControllableThreadEventLog();
    const threadStore = options.threadStore ?? new InMemoryThreadStore();
    const sandboxProvider = options.sandboxProvider ?? new FakeSandboxProvider();
    const repositoryServices = assembleRepositoryServices({
      threadStore,
      repositories: options.threadRepositoryStore ?? repositoryStoreOf(threadStore),
      connections: options.githubConnectionStore ?? new InMemoryGithubConnectionStore(),
      github: options.github ?? testGithubSettings,
      logger,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.credentialRequestLimits === undefined
        ? {}
        : { credentialRequestLimits: options.credentialRequestLimits }),
      ...(options.maximumBundleSizeInBytes === undefined
        ? {}
        : { maximumBundleSizeInBytes: options.maximumBundleSizeInBytes }),
      ...(options.gitChildLimits === undefined ? {} : { gitChildLimits: options.gitChildLimits }),
    });
    const keyring = new CredentialKeyring(randomBytes(32));
    const chatGptPlanStore = options.chatGptPlanStore ?? new InMemoryChatGptPlanStore(keyring);
    const chatGptPlanSettings = {
      isOffered: options.chatGptPlan !== undefined && options.chatGptPlan.isOffered !== false,
      issuer: options.chatGptPlan?.signInIssuer ?? openAiSignInIssuer,
    };
    const signInClient = new ChatGptSignInClient(chatGptPlanSettings.issuer);
    const chatGptPlan = new ChatGptPlanAccess({
      settings: chatGptPlanSettings,
      store: chatGptPlanStore,
      client: signInClient,
      logger,
      sleep: async () => undefined,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const modelCredentials = new ModelCredentials({
      store: options.modelCredentialStore ?? new InMemoryModelCredentialStore(keyring),
      chatGptPlan,
      logger,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const isModelRequired = options.isModelRequired ?? false;
    const modelProxyTokens = new ModelProxyTokens(
      options.modelProxyTokenStore ?? new InMemoryModelProxyTokenStore(),
      options.clock,
    );
    const modelSwitchAllowances = new ModelSwitchAllowances({
      store: options.modelSwitchAllowanceStore ?? new InMemoryModelSwitchAllowanceStore(),
      threadEventLog,
      tokens: modelProxyTokens,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const openAiAccessAllowances = new OpenAiAccessAllowances({
      store: options.openAiAccessAllowanceStore ?? new InMemoryOpenAiAccessAllowanceStore(),
      threadEventLog,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const modelUsage = new ModelUsage({
      store: options.modelUsageStore ?? new InMemoryModelUsageStore(),
      settings: { installationCapTokens: undefined, windowHours: 24, ...options.modelUsageCap },
      logger,
    });
    const supervisorEnvironment = options.supervisorEnvironment ?? testSupervisorEnvironment;
    const threadServices = assembleThreadServices({
      threadStore,
      threadEventLog,
      sandboxProvider,
      sandboxProviderName: "fake",
      supervisorEnvironment,
      settings: { ...testLifecycleSettings, ...options.lifecycleSettings },
      workspaces: repositoryServices.workspaces,
      modelAccess: new OwnerModelAccess({
        threadStore,
        credentials: modelCredentials,
        chatGptPlan,
        isModelRequired,
        proxyTokens: modelProxyTokens,
        usage: modelUsage,
        controlPlaneUrlForSandboxes: supervisorEnvironment.controlPlaneUrlForSandboxes.replace(
          /^ws/,
          "http",
        ),
      }),
      logger,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      timing: {
        providerRetryDelaysInMilliseconds: options.retryDelaysInMilliseconds ?? [],
        interruptGracePeriodInMilliseconds: options.interruptGracePeriodInMilliseconds ?? 300,
      },
    });
    const userStore = options.userStore ?? new InMemoryUserStore();
    const { admission, ...authentication } = createTestAuthentication(
      options.authentication ?? { kind: "development" },
      userStore,
      logger,
    );
    const modelProxy = assembleModelProxy({
      threadStore,
      modelSwitchAllowances,
      openAiAccessAllowances,
      userStore,
      admission,
      credentials: modelCredentials,
      chatGptPlan,
      tokens: modelProxyTokens,
      usage: modelUsage,
      endings: threadServices.relays,
      upstreamOrigin: options.modelProxyUpstreamOrigin,
      ...(options.modelProxyLimits === undefined ? {} : { limits: options.modelProxyLimits }),
      logger,
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
      relays: threadServices.relays,
      desktops: threadServices.desktops,
      sandboxLifecycle: threadServices.sandboxLifecycle,
      repositoryServices,
      modelAccess: {
        credentials: modelCredentials,
        changes: new ModelAccessChanges(threadStore, threadServices.relays, {
          modelSwitches: modelSwitchAllowances,
          openAiAccess: openAiAccessAllowances,
        }),
        isModelRequired,
      },
      modelProxy,
      modelUsage,
      chatGptPlan: {
        access: chatGptPlan,
        signIn: !chatGptPlanSettings.isOffered
          ? undefined
          : new ChatGptSignIn({
              store: chatGptPlanStore,
              client: signInClient,
              logger,
              ...(options.clock === undefined ? {} : { clock: options.clock }),
            }),
        models: !chatGptPlanSettings.isOffered
          ? undefined
          : new ChatGptPlanModels(
              chatGptPlan,
              `${options.modelProxyUpstreamOrigin ?? "https://api.openai.com"}/v1`,
            ),
      },
      publisher: repositoryServices.createPublisher(threadServices.relays),
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
      threadStore,
      sandboxProvider,
      threadServices,
      repositoryServices,
      modelCredentials,
      chatGptPlan,
      modelUsage,
      modelProxyTokens,
      modelProxy,
      logLines,
      closeServer: async () => {
        await modelProxy.shutDown(5_000);
        await server.close();
        await threadServices.operations.whenSettled();
      },
    });
  }

  /**
   * Creates a thread through the API as a browser would, and waits until
   * its sandbox is settled; with no model unless given one (which needs the
   * user's key for its provider).
   */
  async createThread(
    accessToken = developmentAccessToken,
    model: string | undefined = undefined,
  ): Promise<TestThread> {
    const requestBody = JSON.stringify(model === undefined ? {} : { model });
    const response = await this.postThread({ ...browserHeaders(accessToken) }, requestBody);
    if (response.status !== 201) {
      throw new Error(`Creating a thread answered ${response.status}: ${await response.text()}`);
    }
    const { thread } = threadResponseSchema.parse(await response.json());
    await this.whenOperationsSettle();
    const { threadId } = thread;
    return { threadId, supervisorToken: this.supervisorTokenGivenFor(threadId) };
  }

  /** Resolves once every sandbox operation started so far has finished. */
  whenOperationsSettle(): Promise<void> {
    return this.threadServices.operations.whenSettled();
  }

  /** Sends a request with a JSON body, as development mode's user from an allowed origin unless told otherwise. */
  sendApi(
    method: "POST" | "DELETE",
    path: string,
    accessToken = developmentAccessToken,
  ): Promise<Response> {
    return fetch(`${this.httpBaseUrl}${path}`, {
      method,
      headers: browserHeaders(accessToken),
      body: method === "POST" ? "{}" : null,
    });
  }

  /** Adds or replaces the user's key for the provider through the API, as Settings does. */
  async saveModelCredential(
    providerId: string,
    secret: string,
    accessToken = developmentAccessToken,
    settings: Record<string, string> = {},
  ): Promise<Response> {
    return this.sendJson(
      "PUT",
      buildModelCredentialApiPath(providerId),
      { secret, settings },
      accessToken,
    );
  }

  /** Sends a request with a JSON body of the test's choosing, from an allowed origin. */
  sendJson(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    accessToken = developmentAccessToken,
  ): Promise<Response> {
    return fetch(`${this.httpBaseUrl}${path}`, {
      method,
      headers: browserHeaders(accessToken),
      body: JSON.stringify(body),
    });
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

  /** The token the provider was last asked to give the thread's supervisor when creating its sandbox. */
  supervisorTokenGivenFor(threadId: string): string {
    const secrets = this.sandboxProvider.calls.flatMap((call) =>
      call.operation === "create" && call.request.threadId === threadId
        ? [call.request.supervisorSecrets]
        : [],
    );
    const { BARRACK_SUPERVISOR_TOKEN: token } = secrets.at(-1) ?? {};
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

function repositoryStoreOf(threadStore: ThreadStore): ThreadRepositoryStore {
  if (!(threadStore instanceof InMemoryThreadStore)) {
    throw new Error(
      "A test control plane on another thread store needs its threadRepositoryStore.",
    );
  }
  return threadStore.repositories;
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
): ConfiguredAuthentication {
  if (authentication.kind === "development") {
    return {
      admission: { kind: "anyone-who-can-sign-in" },
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
    admission,
    authenticator: new Authenticator({ verifier, admission, userStore, logger }),
    clientAuthentication: {
      method: "supabase",
      supabaseUrl: project.url,
      supabasePublishableKey: project.publishableKey,
    },
  };
}
