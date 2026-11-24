import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { acceptClientUpgrade } from "./client-endpoint.js";
import { rejectUpgrade } from "./reject-upgrade.js";
import { acceptSupervisorUpgrade } from "./supervisor-endpoint.js";
import type { UpgradeDependencies } from "./upgrade-dependencies.js";

/**
 * Handles the HTTP server's `upgrade` event. The last path segment picks the
 * endpoint; the endpoint's protocol parser then checks the whole request
 * target, so a malformed path for a known endpoint is reported precisely.
 * The endpoints look the thread up before accepting and answer every
 * failure of that themselves, so their promises need no handling here.
 */
export function createUpgradeRouter(
  dependencies: UpgradeDependencies,
): (request: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (request, socket, head) => {
    socket.on("error", (error) =>
      dependencies.logger.warn(
        { err: error },
        "A connection failed while upgrading to a WebSocket",
      ),
    );
    const pathname = URL.parse(request.url ?? "", "http://placeholder.invalid")?.pathname ?? "";
    if (pathname.endsWith("/supervisor")) {
      void acceptSupervisorUpgrade(request, socket, head, dependencies);
      return;
    }
    if (pathname.endsWith("/client")) {
      void acceptClientUpgrade(request, socket, head, dependencies);
      return;
    }
    dependencies.logger.warn({ pathname }, "Refused a WebSocket upgrade for an unknown path");
    rejectUpgrade(socket, 404, `There is no WebSocket endpoint at "${pathname}".`);
  };
}
