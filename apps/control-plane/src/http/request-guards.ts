import type { MiddlewareHandler } from "hono";
import { respondWithApiError } from "./api-error.js";

/**
 * Refuses an API request from a web page on an origin the installation does
 * not serve its client from. Browsers send `Origin` on every cross-origin
 * request and on every POST, and pages cannot forge it. A request without
 * one is let through: native apps and other programs send none, and they
 * must present an access token like everyone else.
 *
 * The access token is what stops other websites acting through the user's
 * browser: it is not sent automatically, as a cookie would be. This check is
 * a second fence, and the one that matters in development mode, whose token
 * is no secret.
 */
export function refuseDisallowedOrigins(allowedOrigins: ReadonlySet<string>): MiddlewareHandler {
  return async (context, next) => {
    const origin = context.req.header("origin");
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return respondWithApiError(
        context,
        403,
        "forbidden_origin",
        `Origin "${origin}" is not allowed to make this request.`,
      );
    }
    await next();
    return undefined;
  };
}

/**
 * A request that changes something must declare a JSON body. A plain HTML
 * form cannot send that content type, and a script on another site can only
 * by asking first (a CORS preflight), which this server never approves.
 */
export function requireJsonBody(): MiddlewareHandler {
  return async (context, next) => {
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
