import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

/**
 * The plain HTTP routes. WebSocket upgrades never reach this app; they are
 * handled on the server's `upgrade` event (see `websocket/route-upgrade.ts`).
 */
export function createHttpApp(webClientDirectory: string | undefined): Hono {
  const app = new Hono();
  app.get("/health", (context) => context.json({ status: "ok" }));
  if (webClientDirectory !== undefined) {
    app.use("/*", serveStatic({ root: webClientDirectory }));
  }
  return app;
}
