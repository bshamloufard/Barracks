import { clientConfigurationPath, clientConfigurationSchema } from "@barrack/protocol";
import { FakeSandboxProvider } from "@barrack/sandbox-providers";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { Authenticator } from "../authentication/authenticator.js";
import {
  DevelopmentSingleUserVerifier,
  developmentAccessToken,
} from "../authentication/development-single-user.js";
import { InMemoryOpenAiAccessAllowanceStore } from "../chatgpt-plan/in-memory-openai-access-allowance-store.js";
import { OpenAiAccessAllowances } from "../chatgpt-plan/openai-access-allowances.js";
import { InMemoryGithubConnectionStore } from "../github/in-memory-github-connection-store.js";
import { CredentialKeyring } from "../model-access/credential-keyring.js";
import { InMemoryModelCredentialStore } from "../model-access/in-memory-model-credential-store.js";
import { ModelAccessChanges } from "../model-access/model-access-changes.js";
import { ModelCredentials } from "../model-access/model-credentials.js";
import { InMemoryModelProxyTokenStore } from "../model-proxy/in-memory-model-proxy-token-store.js";
import { InMemoryModelSwitchAllowanceStore } from "../model-proxy/in-memory-model-switch-allowance-store.js";
import { ModelProxyTokens } from "../model-proxy/model-proxy-tokens.js";
import { ModelSwitchAllowances } from "../model-proxy/model-switch-allowances.js";
import { InMemoryModelUsageStore } from "../model-usage/in-memory-model-usage-store.js";
import { ModelUsage } from "../model-usage/model-usage.js";
import { assembleRepositoryServices } from "../repositories/assemble-repository-services.js";
import { assembleThreadServices } from "../sandbox-lifecycle/assemble-thread-services.js";
import {
  testGithubSettings,
  testLifecycleSettings,
  testSupervisorEnvironment,
} from "../test-support/test-control-plane.js";
import { createUnofferedChatGptPlan } from "../test-support/unoffered-chatgpt-plan.js";
import { InMemoryThreadEventLog } from "../thread-event-log/in-memory-thread-event-log.js";
import { InMemoryThreadStore } from "../threads/in-memory-thread-store.js";
import { InMemoryUserStore } from "../users/in-memory-user-store.js";
import { authorizeWithThreadTokens } from "../websocket/supervisor-authorization.js";
import { createHttpApp, publicApiPaths } from "./http-app.js";
import { publicationBundleUploadRoute } from "./publication-routes.js";

/**
 * Guards against a route added later answering without a token: every
 * route registered on the app, whatever it is, is requested here without
 * one, and only the listed public paths may answer.
 *
 * The model proxy (`/threads/{id}/model-proxy/…`) is not one of the app's
 * routes: the server hands it its requests before the app sees them
 * (`route-http-request.ts`), and it authenticates each by the thread's
 * proxy token, which its own tests refuse without (`model-proxy/`).
 */

const logger = pino({ level: "silent" });

function createApp() {
  const threadStore = new InMemoryThreadStore();
  const threadEventLog = new InMemoryThreadEventLog();
  const repositoryServices = assembleRepositoryServices({
    threadStore,
    repositories: threadStore.repositories,
    connections: new InMemoryGithubConnectionStore(),
    github: testGithubSettings,
    logger,
  });
  const { sandboxLifecycle, relays } = assembleThreadServices({
    threadStore,
    threadEventLog,
    sandboxProvider: new FakeSandboxProvider(),
    sandboxProviderName: "fake",
    supervisorEnvironment: testSupervisorEnvironment,
    settings: testLifecycleSettings,
    logger,
  });
  const keyring = new CredentialKeyring(Buffer.alloc(32, 1));
  const chatGptPlan = createUnofferedChatGptPlan(keyring);
  const modelAccessChanges = new ModelAccessChanges(threadStore, relays, {
    modelSwitches: new ModelSwitchAllowances({
      store: new InMemoryModelSwitchAllowanceStore(),
      threadEventLog,
      tokens: new ModelProxyTokens(new InMemoryModelProxyTokenStore()),
    }),
    openAiAccess: new OpenAiAccessAllowances({
      store: new InMemoryOpenAiAccessAllowanceStore(),
      threadEventLog,
    }),
  });
  return createHttpApp({
    authenticator: new Authenticator({
      verifier: new DevelopmentSingleUserVerifier(),
      admission: { kind: "anyone-who-can-sign-in" },
      userStore: new InMemoryUserStore(),
      logger,
    }),
    acceptOnlyLoopbackHosts: false,
    clientAuthentication: {
      method: "development-single-user",
      accessToken: developmentAccessToken,
    },
    allowedClientOrigins: new Set(),
    threads: {
      threadStore,
      threadEventLog,
      sandboxLifecycle,
      repositories: {
        requests: repositoryServices.requests,
        store: repositoryServices.repositories,
        isGithubAvailable: false,
      },
      modelAccess: {
        credentials: new ModelCredentials({
          store: new InMemoryModelCredentialStore(keyring),
          chatGptPlan,
          logger,
        }),
        changes: modelAccessChanges,
        isModelRequired: true,
      },
      logger,
    },
    github: { githubConnections: repositoryServices.githubConnections, logger },
    publication: {
      publisher: repositoryServices.createPublisher(relays),
      uploads: repositoryServices.uploads,
      authorizeSupervisor: authorizeWithThreadTokens(threadStore),
      logger,
    },
    modelUsage: {
      usage: new ModelUsage({
        store: new InMemoryModelUsageStore(),
        settings: { installationCapTokens: undefined, windowHours: 24 },
        logger,
      }),
      threadStore,
      logger,
    },
    chatGptPlan: {
      access: chatGptPlan,
      signIn: undefined,
      models: undefined,
      changes: modelAccessChanges,
      logger,
    },
    webClientDirectory: undefined,
  });
}

/** Every method and concrete path the app has a handler for, middleware aside. */
function registeredRoutes(): Array<{ method: string; path: string }> {
  const routes = createApp().routes.filter((route) => !route.path.endsWith("*"));
  return routes.map((route) => ({
    method: route.method === "ALL" ? "GET" : route.method,
    path: route.path.replaceAll(/:[A-Za-z]+/g, "some-identifier"),
  }));
}

describe("the HTTP API's access control", () => {
  it("has routes to check, the thread lifecycle's among them", () => {
    const routes = registeredRoutes().map((route) => `${route.method} ${route.path}`);

    expect(routes).toEqual(
      expect.arrayContaining([
        "POST /api/threads/some-identifier/stop",
        "POST /api/threads/some-identifier/resume",
        "DELETE /api/threads/some-identifier",
        "POST /api/threads/some-identifier/publication",
        "PUT /api/threads/some-identifier/model",
        "GET /api/model-catalogue",
        "GET /api/model-credentials",
        "PUT /api/model-credentials/some-identifier",
        "DELETE /api/model-credentials/some-identifier",
        "GET /api/model-usage",
        "PUT /api/model-usage/own-cap",
        "GET /api/threads/some-identifier/model-usage",
        "GET /api/github/connection",
        "POST /api/github/connection",
        "DELETE /api/github/connection",
        "POST /api/github/connection-attempts",
        "PUT /threads/some-identifier/supervisor/publication-bundles/some-identifier",
      ]),
    );
  });

  it.each(registeredRoutes())(
    "answers $method $path without a token only if it is public",
    async ({ method, path }) => {
      const response = await createApp().request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" ? null : "{}",
      });

      const isPublic = publicApiPaths.has(path) || path === "/health";
      if (isPublic) {
        expect(response.status).toBe(200);
      } else {
        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);
      }
      if (path.startsWith("/api/") && !isPublic) {
        expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
      }
    },
  );

  it("keeps the paths outside the API to the health check and the supervisor's bundle upload", () => {
    const outsideApi = registeredRoutes().filter((route) => !route.path.startsWith("/api/"));

    expect(outsideApi.map((route) => route.path)).toEqual([
      "/health",
      publicationBundleUploadRoute.replaceAll(/:[A-Za-z]+/g, "some-identifier"),
    ]);
  });

  it("answers an unknown API path without a token with 401, not 404, so routes cannot be probed", async () => {
    const response = await createApp().request("/api/nothing-here");

    expect(response.status).toBe(401);
  });

  it("refuses a malformed or unknown token with 401", async () => {
    for (const authorization of ["Bearer", "Basic abc", "Bearer not-the-token"]) {
      const response = await createApp().request("/api/threads", {
        headers: { Authorization: authorization },
      });

      expect(response.status).toBe(401);
    }
  });

  it("tells clients how to sign in without a token, and nothing secret", async () => {
    const response = await createApp().request(clientConfigurationPath);

    expect(clientConfigurationSchema.parse(await response.json())).toEqual({
      authentication: { method: "development-single-user", accessToken: developmentAccessToken },
    });
  });
});
