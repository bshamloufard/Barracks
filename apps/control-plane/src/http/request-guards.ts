import type { MiddlewareHandler } from "hono";
import { respondWithApiError } from "./api-error.js";

/**
 * Stops other websites from changing anything through the user's browser
 * while there is no sign-in (cross-site request forgery). Two checks, each
 * enough on its own in today's browsers:
 *
 * - The `Origin` header, which browsers send on every cross-origin request
 *   and on every POST, and which pages cannot forge, must be one the client
 *   WebSocket endpoint also allows. A request without one is refused, so
 *   programs other than browsers must send an allowed origin too.
 * - The body must be declared JSON. A plain HTML form cannot send that
 *   content type, and a script on another site can only by asking first
 *   (a CORS preflight), which this server never approves.
 *
 * Neither stops a program on the same machine, which is why the control
 * plane listens only on the loopback interface by default.
 */
export function guardStateChangingRequests(allowedOrigins: ReadonlySet<string>): MiddlewareHandler {
  return async (context, next) => {
    const origin = context.req.header("origin");
    if (origin === undefined || !allowedOrigins.has(origin)) {
      return respondWithApiError(
        context,
        403,
        "forbidden_origin",
        `Origin "${origin ?? ""}" is not allowed to make this request.`,
      );
    }
    if (!isJsonMediaType(context.req.header("content-type"))) {
      return respondWithApiError(
        context,
        415,
        "unsupported_media_type",
        "The request body must be JSON, sent with Content-Type: application/json.",
      );
    }
    await next();
    return undefined;
  };
}

/** Allows parameters such as `; charset=utf-8`. https://www.rfc-editor.org/rfc/rfc9110#section-8.3 */
function isJsonMediaType(contentType: string | undefined): boolean {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}
