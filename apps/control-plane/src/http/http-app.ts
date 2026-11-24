import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { respondWithApiError } from "./api-error.js";
import { addThreadsRoutes, type ThreadsRoutesDependencies } from "./threads-routes.js";

export type HttpAppOptions = {
  threads: ThreadsRoutesDependencies;
  /** Where the built web client is; when set, it is served from `/`. */
  webClientDirectory: string | undefined;
};

/**
 * The plain HTTP routes. WebSocket upgrades never reach this app; they are
 * handled on the server's `upgrade` event (see `websocket/route-upgrade.ts`).
 */
export function createHttpApp(options: HttpAppOptions): Hono {
  const app = new Hono();
  app.get("/health", (context) => context.json({ status: "ok" }));
  addThreadsRoutes(app, options.threads);
  app.all("/api/*", (context) =>
    respondWithApiError(context, 404, "not_found", "There is no such API route."),
  );
  if (options.webClientDirectory !== undefined) {
    app.use("/*", serveStatic({ root: options.webClientDirectory }));
  }
  return app;
}
