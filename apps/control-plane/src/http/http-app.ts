import {
  type ClientAuthenticationConfiguration,
  type ClientConfiguration,
  clientConfigurationPath,
} from "@barrack/protocol";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Authenticator } from "../authentication/authenticator.js";
import { respondWithApiError } from "./api-error.js";
import { refuseDisallowedOrigins } from "./request-guards.js";
import { requireSignedInUser, type SignedInEnvironment } from "./require-signed-in-user.js";
import { addThreadsRoutes, type ThreadsRoutesDependencies } from "./threads-routes.js";

export type HttpAppOptions = {
  authenticator: Authenticator;
  /** What clients are told about signing in, which they must know before they can. */
  clientAuthentication: ClientAuthenticationConfiguration;
  allowedClientOrigins: ReadonlySet<string>;
  threads: ThreadsRoutesDependencies;
  /** Where the built web client is; when set, it is served from `/`. */
  webClientDirectory: string | undefined;
};

/**
 * The only API paths that answer without an access token: what a client
 * needs to know to sign in. `/health` and the web client's files are outside
 * `/api` and public too.
 */
export const publicApiPaths: ReadonlySet<string> = new Set([clientConfigurationPath]);

/**
 * The plain HTTP routes. WebSocket upgrades never reach this app; they are
 * handled on the server's `upgrade` event (see `websocket/route-upgrade.ts`).
 *
 * The order matters: the origin check and the authentication middleware are
 * mounted on all of `/api/*` before any API route, so every API route, those
 * added later included, is behind them unless listed in `publicApiPaths`.
 */
export function createHttpApp(options: HttpAppOptions): Hono<SignedInEnvironment> {
  const app = new Hono<SignedInEnvironment>();
  app.get("/health", (context) => context.json({ status: "ok" }));
  app.use("/api/*", refuseDisallowedOrigins(options.allowedClientOrigins));
  app.use("/api/*", requireSignedInUser(options.authenticator, publicApiPaths));
  const clientConfiguration: ClientConfiguration = {
    authentication: options.clientAuthentication,
  };
  app.get(clientConfigurationPath, (context) => context.json(clientConfiguration));
  addThreadsRoutes(app, options.threads);
  app.all("/api/*", (context) =>
    respondWithApiError(context, 404, "not_found", "There is no such API route."),
  );
  if (options.webClientDirectory !== undefined) {
    app.use("/*", serveStatic({ root: options.webClientDirectory }));
  }
  return app;
}
