import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { respondWithApiError } from "./api-error.js";

/** Every API request body is a small JSON object; anything much larger is not one this API understands. */
const maximumRequestBodyInBytes = 16 * 1024;

export function limitBodySize(): MiddlewareHandler {
  return bodyLimit({
    maxSize: maximumRequestBodyInBytes,
    onError: (context) =>
      respondWithApiError(context, 413, "payload_too_large", "The request body is too large."),
  });
}

/** The parsed body, or undefined when it is not JSON, which the route's schema then refuses. */
export async function readJsonBody(context: Context): Promise<unknown> {
  try {
    const body: unknown = await context.req.json();
    return body;
  } catch {
    return undefined;
  }
}

export function respondUnavailable(context: Context, message: string): Response {
  return respondWithApiError(context, 503, "unavailable", `${message} Try again later.`);
}
