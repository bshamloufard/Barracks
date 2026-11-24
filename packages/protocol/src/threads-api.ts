import { z } from "zod";
import { threadIdSchema } from "./identifier.js";
import { maximumErrorMessageLength } from "./limits.js";

/**
 * The control plane's HTTP API for threads: create one, list them, fetch
 * one. Requests and responses are JSON. Every client (the web page now, the
 * native apps later) reads them through these schemas, so the shapes are
 * defined once, like the WebSocket messages.
 *
 * Thread identifiers are minted by the control plane when a thread is
 * created; clients never choose them.
 *
 * Every request carries `Authorization: Bearer <access token>`, and sees and
 * changes only the signed-in user's own threads: another user's thread is
 * answered exactly as one that does not exist.
 */

export const threadsApiPath = "/api/threads";

export function buildThreadApiPath(threadId: string): string {
  return `${threadsApiPath}/${encodeURIComponent(threadId)}`;
}

/**
 * Where the thread's sandbox is in coming into existence. Whether the agent
 * inside it is reachable right now is a separate, live matter, told over the
 * thread's WebSocket (`supervisor_connection_status`).
 *
 * - `creating`: the control plane is asking the sandbox provider for it.
 * - `ready`: the sandbox exists and its supervisor has been launched.
 * - `failed`: it could not be created; `reason` says why, for the user.
 */
export const threadSandboxSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("creating") }),
  z.strictObject({ state: z.literal("ready") }),
  z.strictObject({
    state: z.literal("failed"),
    reason: z.string().min(1).max(maximumErrorMessageLength),
  }),
]);

export const threadSummarySchema = z.strictObject({
  threadId: threadIdSchema,
  createdAt: z.iso.datetime(),
  sandbox: threadSandboxSchema,
});

/** A new thread takes no settings yet; the body is an empty JSON object. */
export const createThreadRequestSchema = z.strictObject({});

/** The answer to creating a thread (201) and to fetching one (200). */
export const threadResponseSchema = z.strictObject({ thread: threadSummarySchema });

/** Threads newest first. */
export const threadListResponseSchema = z.strictObject({
  threads: z.array(threadSummarySchema),
});

/**
 * Every refused or failed request answers with this body. `code` is stable
 * and meant for programs; `message` is meant for people.
 *
 * - `unauthorized` (401): no access token, or one that is not valid or has
 *   expired. Refresh the session, or sign in again.
 * - `not_allowed` (403): signed in, but this installation does not let the
 *   user use it. Signing in again as the same user will not help.
 * - `forbidden_host` (403): a control plane in development mode was reached
 *   by a name other than localhost, 127.0.0.1 or [::1].
 */
export const apiErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      "unauthorized",
      "not_allowed",
      "bad_request",
      "forbidden_origin",
      "forbidden_host",
      "unsupported_media_type",
      "payload_too_large",
      "not_found",
      "unavailable",
    ]),
    message: z.string().min(1),
  }),
});

export type ThreadSandbox = z.infer<typeof threadSandboxSchema>;
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;
export type ThreadResponse = z.infer<typeof threadResponseSchema>;
export type ThreadListResponse = z.infer<typeof threadListResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type ApiErrorCode = ApiErrorResponse["error"]["code"];
