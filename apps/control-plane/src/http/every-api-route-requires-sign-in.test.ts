import { clientConfigurationPath, clientConfigurationSchema } from "@barrack/protocol";
import { FakeSandboxProvider } from "@barrack/sandbox-providers";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { Authenticator } from "../authentication/authenticator.js";
import {
  DevelopmentSingleUserVerifier,
  developmentAccessToken,
} from "../authentication/development-single-user.js";
import { testSupervisorEnvironment } from "../test-support/test-control-plane.js";
import { InMemoryThreadStore } from "../threads/in-memory-thread-store.js";
import { ThreadCreator } from "../threads/thread-creator.js";
import { InMemoryUserStore } from "../users/in-memory-user-store.js";
import { createHttpApp, publicApiPaths } from "./http-app.js";

/**
 * Guards against a route added later answering without a token: every
 * route registered on the app, whatever it is, is requested here without
 * one, and only the listed public paths may answer.
 */

const logger = pino({ level: "silent" });

function createApp() {
  const threadStore = new InMemoryThreadStore();
  return createHttpApp({
    authenticator: new Authenticator({
      verifier: new DevelopmentSingleUserVerifier(),
      admission: { kind: "anyone-who-can-sign-in" },
      userStore: new InMemoryUserStore(),
      logger,
    }),
    clientAuthentication: {
      method: "development-single-user",
      accessToken: developmentAccessToken,
    },
    allowedClientOrigins: new Set(),
    threads: {
      threadStore,
      threadCreator: new ThreadCreator({
        threadStore,
        sandboxProvider: new FakeSandboxProvider(),
        sandboxProviderName: "fake",
        supervisorEnvironment: testSupervisorEnvironment,
        logger,
      }),
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
  it("has routes to check", () => {
    expect(registeredRoutes().length).toBeGreaterThan(3);
  });

  it.each(registeredRoutes())(
    "answers $method $path without a token only if it is public",
    async ({ method, path }) => {
      const response = await createApp().request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" ? null : "{}",
      });

      const isPublic = publicApiPaths.has(path) || !path.startsWith("/api/");
      if (isPublic) {
        expect(response.status).toBe(200);
      } else {
        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);
        expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
      }
    },
  );

  it("keeps the public paths outside the API to the health check", () => {
    const outsideApi = registeredRoutes().filter((route) => !route.path.startsWith("/api/"));

    expect(outsideApi.map((route) => route.path)).toEqual(["/health"]);
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
