import { z } from "zod";
import { threadIdSchema } from "./identifier.js";
import { maximumErrorMessageLength } from "./limits.js";
import {
  commitIdSchema,
  threadRepositoryRequestSchema,
  threadRepositorySummarySchema,
} from "./repositories.js";

/**
 * The control plane's HTTP API for threads: create one, list them, fetch
 * one, stop or resume its sandbox, delete it. Requests and responses are
 * JSON. Every client (the web page now, the native apps later) reads them
 * through these schemas, so the shapes are defined once, like the WebSocket
 * messages.
 *
 * - `POST /api/threads` with `{}`, or `{ "repository": … }` to start from a
 *   Git repository: create (201), or 409 `sandbox_limit_reached` when the
 *   user already runs as many sandboxes as allowed, saying which; 400 for a
 *   repository URL Barrack does not accept, 403 `repository_not_allowed`
 *   for a repository the user has not been verified to have access to.
 * - `GET /api/threads`: the user's threads, the most recently active first.
 * - `GET /api/threads/{threadId}`: one thread.
 * - `POST /api/threads/{threadId}/stop` with `{}`: stop its sandbox, files
 *   kept (202). 409 `conflict` if it is not running.
 * - `POST /api/threads/{threadId}/resume` with `{}`: start it again (202).
 *   409 `conflict` if it is not stopped (or failed with its sandbox), or
 *   `sandbox_limit_reached`.
 * - `DELETE /api/threads/{threadId}`: destroy its sandbox and remove it and
 *   its history for good (202, then it disappears). 409 `conflict` while its
 *   sandbox is starting or stopping.
 * - `POST /api/threads/{threadId}/publication` with
 *   `{ "openPullRequest": boolean }`: push the work branch to the
 *   repository, and open a pull request for it if asked and none is open
 *   (200, once done). 409 `conflict` when publishing is not available or the
 *   sandbox is not running, 409 `publication_failed` when it was tried and
 *   failed; the thread's history records the outcome either way.
 *
 * Accepted changes are carried out in the background; the answer is the
 * thread as the request left it, and fetching it again shows how it went.
 * A message sent over the thread's WebSocket to a stopped sandbox wakes it,
 * so a client need not resume a thread before writing to it.
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

export function buildStopThreadApiPath(threadId: string): string {
  return `${buildThreadApiPath(threadId)}/stop`;
}

export function buildResumeThreadApiPath(threadId: string): string {
  return `${buildThreadApiPath(threadId)}/resume`;
}

export function buildPublishThreadApiPath(threadId: string): string {
  return `${buildThreadApiPath(threadId)}/publication`;
}

/** Why a requested change did not happen, or what went wrong; for the user. */
const reasonSchema = z.string().min(1).max(maximumErrorMessageLength);

/**
 * What the thread's sandbox is doing. Whether the agent inside it is
 * reachable right now is a separate, live matter, told over the thread's
 * WebSocket (`supervisor_connection_status`).
 *
 * - `creating`: the control plane is asking the sandbox provider for it.
 * - `running`: it runs, with its agent. `problem`, if any, says why a stop
 *   the user asked for did not happen.
 * - `stopping`: it is being stopped, with its files kept.
 * - `stopped`: it is stopped, costing no compute. A message wakes it.
 *   `problem`, if any, says why the last start or deletion did not happen.
 * - `starting`: it is being started again (resumed, or woken by a message).
 * - `failed`: something went wrong, as `reason` says. If `canResume`,
 *   resuming tries to start it again; otherwise it is gone, and the thread
 *   can only be deleted.
 * - `deleting`: it is being destroyed, and the thread with it.
 */
export const threadSandboxSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("creating") }),
  z.strictObject({ state: z.literal("running"), problem: reasonSchema.optional() }),
  z.strictObject({ state: z.literal("stopping") }),
  z.strictObject({ state: z.literal("stopped"), problem: reasonSchema.optional() }),
  z.strictObject({ state: z.literal("starting") }),
  z.strictObject({ state: z.literal("failed"), reason: reasonSchema, canResume: z.boolean() }),
  z.strictObject({ state: z.literal("deleting") }),
]);

/** At most this long; the control plane derives it from the first user message. */
export const maximumThreadTitleLength = 200;

export const threadSummarySchema = z.strictObject({
  threadId: threadIdSchema,
  createdAt: z.iso.datetime(),
  /** When a user or the agent last did something in the thread; creating it counts. */
  lastActiveAt: z.iso.datetime(),
  /** From the thread's first user message; null until there is one. */
  title: z.string().min(1).max(maximumThreadTitleLength).nullable(),
  /** The agent is in the middle of a run. */
  isAgentWorking: z.boolean(),
  sandbox: threadSandboxSchema,
  /** The repository the thread started from, or null for an empty workspace. */
  repository: threadRepositorySummarySchema.nullable(),
});

/** A new thread starts from an empty workspace, or from one repository. */
export const createThreadRequestSchema = z.strictObject({
  repository: threadRepositoryRequestSchema.optional(),
});

/** Publishing pushes the work branch; `openPullRequest` also opens a pull request for it. */
export const publishThreadRequestSchema = z.strictObject({ openPullRequest: z.boolean() });

/** What a publication did: the commit pushed, and the pull request for the branch, if any. */
export const publishThreadResponseSchema = z.strictObject({
  workBranch: z.string().min(1),
  commit: commitIdSchema,
  branchUrl: z.url(),
  pullRequestUrl: z.url().nullable(),
});

/** Stopping and resuming take no settings; the body is an empty JSON object. */
export const threadActionRequestSchema = z.strictObject({});

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
 * - `conflict` (409): the thread is not in a state that allows the change;
 *   the message says why.
 * - `sandbox_limit_reached` (409): starting a sandbox would exceed how many
 *   may run at once; the message names the user's running sandboxes.
 * - `repository_not_allowed` (403): the user has not been verified to have
 *   the access to a repository that what they asked for needs.
 * - `publication_failed` (409): publishing was tried and did not happen;
 *   the message says why.
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
      "conflict",
      "sandbox_limit_reached",
      "repository_not_allowed",
      "publication_failed",
      "unavailable",
    ]),
    message: z.string().min(1),
  }),
});

export type ThreadSandbox = z.infer<typeof threadSandboxSchema>;
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;
export type ThreadActionRequest = z.infer<typeof threadActionRequestSchema>;
export type PublishThreadRequest = z.infer<typeof publishThreadRequestSchema>;
export type PublishThreadResponse = z.infer<typeof publishThreadResponseSchema>;
export type ThreadResponse = z.infer<typeof threadResponseSchema>;
export type ThreadListResponse = z.infer<typeof threadListResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type ApiErrorCode = ApiErrorResponse["error"]["code"];
