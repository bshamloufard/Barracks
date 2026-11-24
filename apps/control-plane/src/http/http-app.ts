import {
  type ClientAuthenticationConfiguration,
  type ClientConfiguration,
  clientConfigurationPath,
  githubCallbackPagePath,
} from "@barrack/protocol";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Authenticator } from "../authentication/authenticator.js";
import { respondWithApiError } from "./api-error.js";
import { addGithubRoutes, type GithubRoutesDependencies } from "./github-routes.js";
import { addModelAccessRoutes } from "./model-access-routes.js";
import { addModelUsageRoutes, type ModelUsageRoutesDependencies } from "./model-usage-routes.js";
import { addPublicationRoutes, type PublicationRoutesDependencies } from "./publication-routes.js";
import { refuseDisallowedOrigins, refuseHostsOtherThanLoopback } from "./request-guards.js";
import { requireSignedInUser, type SignedInEnvironment } from "./require-signed-in-user.js";
import { addThreadsRoutes, type ThreadsRoutesDependencies } from "./threads-routes.js";

export type HttpAppOptions = {
  authenticator: Authenticator;
  /** What clients are told about signing in, which they must know before they can. */
  clientAuthentication: ClientAuthenticationConfiguration;
  allowedClientOrigins: ReadonlySet<string>;
  threads: ThreadsRoutesDependencies;
  github: GithubRoutesDependencies;
  publication: PublicationRoutesDependencies;
  modelUsage: ModelUsageRoutesDependencies;
  /** Where the built web client is; when set, it is served from `/`. */
  webClientDirectory: string | undefined;
  /** Answer only requests addressed to loopback, as development mode must. */
  acceptOnlyLoopbackHosts: boolean;
};

/**
 * The only API paths that answer without an access token: what a client
 * needs to know to sign in. `/health` and the web client's files are outside
 * `/api` and public too.
 */
export const publicApiPaths: ReadonlySet<string> = new Set([clientConfigurationPath]);

/**
 * The plain HTTP routes. Outside `/api`, besides `/health` and the web
 * client's files, there is one more: where a supervisor uploads a
 * publication bundle, authenticated by its thread's token instead.
 * WebSocket upgrades never reach this app; they are handled on the
 * server's `upgrade` event (see `websocket/route-upgrade.ts`). Nor does the
 * model proxy's traffic, which streams in both directions and is handed to
 * the proxy before this app (see `route-http-request.ts`).
 *
 * The order matters: the loopback check, when on, comes before every route,
 * the web client's files included; the origin check and the authentication
 * middleware are mounted on all of `/api/*` before any API route, so every
 * API route, those added later included, is behind them unless listed in
 * `publicApiPaths`.
 */
export function createHttpApp(options: HttpAppOptions): Hono<SignedInEnvironment> {
  const app = new Hono<SignedInEnvironment>();
  if (options.acceptOnlyLoopbackHosts) {
    app.use("*", refuseHostsOtherThanLoopback());
  }
  app.get("/health", (context) => context.json({ status: "ok" }));
  app.use("/api/*", refuseDisallowedOrigins(options.allowedClientOrigins));
  app.use("/api/*", requireSignedInUser(options.authenticator, publicApiPaths));
  const clientConfiguration: ClientConfiguration = {
    authentication: options.clientAuthentication,
  };
  app.get(clientConfigurationPath, (context) => context.json(clientConfiguration));
  addThreadsRoutes(app, options.threads);
  addModelAccessRoutes(app, { ...options.threads.modelAccess, logger: options.threads.logger });
  addModelUsageRoutes(app, options.modelUsage);
  addGithubRoutes(app, options.github);
  addPublicationRoutes(app, options.publication);
  app.all("/api/*", (context) =>
    respondWithApiError(context, 404, "not_found", "There is no such API route."),
  );
  if (options.webClientDirectory !== undefined) {
    // GitHub sends users back to this page of the web client, which has no
    // file of its own: the client reads the address and finishes the link.
    app.get(
      githubCallbackPagePath,
      serveStatic({ root: options.webClientDirectory, path: "index.html" }),
    );
    app.use("/*", serveStatic({ root: options.webClientDirectory }));
  }
  return app;
}
