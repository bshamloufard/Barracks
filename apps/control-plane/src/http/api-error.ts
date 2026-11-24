import type { ApiErrorCode, ApiErrorResponse } from "@barrack/protocol";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Answers with the API's one error body shape, so every client handles refusals the same way. */
export function respondWithApiError(
  context: Context,
  statusCode: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
): Response {
  const body: ApiErrorResponse = { error: { code, message } };
  return context.json(body, statusCode);
}
