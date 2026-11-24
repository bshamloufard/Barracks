import {
  createThreadRequestSchema,
  type ThreadListResponse,
  type ThreadResponse,
  type ThreadSandbox,
  type ThreadSummary,
  threadActionRequestSchema,
  threadIdSchema,
  threadsApiPath,
} from "@barrack/protocol";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "../logger.js";
import type {
  LifecycleRequestOutcome,
  SandboxLifecycle,
} from "../sandbox-lifecycle/sandbox-lifecycle.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type { ThreadRecord, ThreadSandboxRecord, ThreadStore } from "../threads/thread-store.js";
import { respondWithApiError } from "./api-error.js";
import { requireJsonBody } from "./request-guards.js";
import { type SignedInEnvironment, signedInUserOf } from "./require-signed-in-user.js";

export type ThreadsRoutesDependencies = {
  threadStore: ThreadStore;
  threadEventLog: ThreadEventLog;
  sandboxLifecycle: SandboxLifecycle;
  logger: Logger;
};

/**
 * The thread list has no paging yet; this many is far more than one person
 * keeps before deleting some.
 */
const listedThreadLimit = 100;

/** A request's body is `{}`; anything much larger is not a request this API understands. */
const maximumRequestBodyInBytes = 16 * 1024;

type ThreadAction = "stop" | "resume";

/**
 * The threads API (its routes and shapes are described in
 * `@barrack/protocol`'s `threads-api.ts`), always about the signed-in user's
 * own threads: another user's thread is answered exactly as one that does
 * not exist. They sit behind `requireSignedInUser`.
 */
export function addThreadsRoutes(
  app: Hono<SignedInEnvironment>,
  dependencies: ThreadsRoutesDependencies,
): void {
  app.post(threadsApiPath, requireJsonBody(), limitBodySize(), (context) =>
    createThread(context, dependencies),
  );
  app.get(threadsApiPath, (context) => listThreads(context, dependencies));
  app.get(`${threadsApiPath}/:threadId`, (context) =>
    fetchThread(context, context.req.param("threadId"), dependencies),
  );
  app.post(`${threadsApiPath}/:threadId/stop`, requireJsonBody(), limitBodySize(), (context) =>
    changeThread(context, context.req.param("threadId"), "stop", dependencies),
  );
  app.post(`${threadsApiPath}/:threadId/resume`, requireJsonBody(), limitBodySize(), (context) =>
    changeThread(context, context.req.param("threadId"), "resume", dependencies),
  );
  app.delete(`${threadsApiPath}/:threadId`, (context) =>
    deleteThread(context, context.req.param("threadId"), dependencies),
  );
}

function limitBodySize(): MiddlewareHandler {
  return bodyLimit({
    maxSize: maximumRequestBodyInBytes,
    onError: (context) =>
      respondWithApiError(context, 413, "payload_too_large", "The request body is too large."),
  });
}

async function createThread(
  context: Context<SignedInEnvironment>,
  dependencies: ThreadsRoutesDependencies,
): Promise<Response> {
  if (!createThreadRequestSchema.safeParse(await readJsonBody(context)).success) {
    return respondWithApiError(
      context,
      400,
      "bad_request",
      "A new thread is created with an empty JSON object, {}, as the body.",
    );
  }
  const { userId } = signedInUserOf(context);
  try {
    const outcome = await dependencies.sandboxLifecycle.createThread(userId);
    return await respondToLifecycleRequest(context, outcome, 201, "", dependencies);
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not create a thread");
    return respondUnavailable(context, "The control plane could not record a new thread.");
  }
}

async function listThreads(
  context: Context<SignedInEnvironment>,
  dependencies: ThreadsRoutesDependencies,
): Promise<Response> {
  const { userId } = signedInUserOf(context);
  try {
    const threads = await dependencies.threadStore.listMostRecentlyActiveOwnedBy(
      userId,
      listedThreadLimit,
    );
    const response: ThreadListResponse = {
      threads: await toThreadSummaries(threads, dependencies.threadEventLog),
    };
    return context.json(response);
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not list threads");
    return respondUnavailable(context, "The control plane could not read its threads.");
  }
}

async function fetchThread(
  context: Context<SignedInEnvironment>,
  threadId: string,
  dependencies: ThreadsRoutesDependencies,
): Promise<Response> {
  if (!threadIdSchema.safeParse(threadId).success) {
    return respondThreadNotFound(context, threadId);
  }
  const { userId } = signedInUserOf(context);
  try {
    const thread = await dependencies.threadStore.findOwnedBy(userId, threadId);
    if (thread === undefined) {
      return respondThreadNotFound(context, threadId);
    }
    return await respondWithThread(context, thread, 200, dependencies);
  } catch (error) {
    dependencies.logger.error({ err: error, threadId }, "Could not read a thread");
    return respondUnavailable(context, "The control plane could not read the thread.");
  }
}

async function changeThread(
  context: Context<SignedInEnvironment>,
  threadId: string,
  action: ThreadAction,
  dependencies: ThreadsRoutesDependencies,
): Promise<Response> {
  if (!threadActionRequestSchema.safeParse(await readJsonBody(context)).success) {
    return respondWithApiError(
      context,
      400,
      "bad_request",
      `A thread is asked to ${action} with an empty JSON object, {}, as the body.`,
    );
  }
  if (!threadIdSchema.safeParse(threadId).success) {
    return respondThreadNotFound(context, threadId);
  }
  const { userId } = signedInUserOf(context);
  const { sandboxLifecycle, logger } = dependencies;
  try {
    const outcome =
      action === "stop"
        ? await sandboxLifecycle.stopThread(userId, threadId)
        : await sandboxLifecycle.resumeThread(userId, threadId);
    return await respondToLifecycleRequest(context, outcome, 202, threadId, dependencies);
  } catch (error) {
    logger.error({ err: error, threadId, action }, "Could not change a thread's sandbox");
    return respondUnavailable(context, `The control plane could not ${action} the thread.`);
  }
}

async function deleteThread(
  context: Context<SignedInEnvironment>,
  threadId: string,
  dependencies: ThreadsRoutesDependencies,
): Promise<Response> {
  if (!threadIdSchema.safeParse(threadId).success) {
    return respondThreadNotFound(context, threadId);
  }
  const { userId } = signedInUserOf(context);
  try {
    const outcome = await dependencies.sandboxLifecycle.deleteThread(userId, threadId);
    return await respondToLifecycleRequest(context, outcome, 202, threadId, dependencies);
  } catch (error) {
    dependencies.logger.error({ err: error, threadId }, "Could not delete a thread");
    return respondUnavailable(context, "The control plane could not delete the thread.");
  }
}

async function respondToLifecycleRequest(
  context: Context,
  outcome: LifecycleRequestOutcome,
  acceptedStatus: 201 | 202,
  threadId: string,
  dependencies: ThreadsRoutesDependencies,
): Promise<Response> {
  switch (outcome.kind) {
    case "accepted":
      return respondWithThread(context, outcome.thread, acceptedStatus, dependencies);
    case "not_found":
      return respondThreadNotFound(context, threadId);
    case "conflict":
      return respondWithApiError(context, 409, "conflict", outcome.message);
    case "limit_reached":
      return respondWithApiError(context, 409, "sandbox_limit_reached", outcome.message);
  }
}

async function respondWithThread(
  context: Context,
  thread: ThreadRecord,
  status: 200 | 201 | 202,
  dependencies: ThreadsRoutesDependencies,
): Promise<Response> {
  const [summary] = await toThreadSummaries([thread], dependencies.threadEventLog);
  const response: ThreadResponse = { thread: summary ?? toThreadSummary(thread, false) };
  return context.json(response, status);
}

/** Whether each agent is working is read for all of them at once, without reading events. */
async function toThreadSummaries(
  threads: ThreadRecord[],
  threadEventLog: ThreadEventLog,
): Promise<ThreadSummary[]> {
  const working = await threadEventLog.findThreadsWithOpenRuns(
    threads.map((thread) => thread.threadId),
  );
  return threads.map((thread) => toThreadSummary(thread, working.has(thread.threadId)));
}

/** What clients may see of a thread: never its token digest, owner, provider or sandbox identifier. */
function toThreadSummary(thread: ThreadRecord, isAgentWorking: boolean): ThreadSummary {
  return {
    threadId: thread.threadId,
    createdAt: thread.createdAt.toISOString(),
    lastActiveAt: thread.lastActivityAt.toISOString(),
    title: thread.title ?? null,
    isAgentWorking,
    sandbox: toSandboxSummary(thread.sandbox),
  };
}

function toSandboxSummary(sandbox: ThreadSandboxRecord): ThreadSandbox {
  switch (sandbox.state) {
    case "running":
    case "stopped":
      return sandbox.problem === undefined
        ? { state: sandbox.state }
        : { state: sandbox.state, problem: sandbox.problem };
    case "failed":
      return {
        state: "failed",
        reason: sandbox.reason,
        canResume: sandbox.sandboxId !== undefined,
      };
    default:
      return { state: sandbox.state };
  }
}

function respondThreadNotFound(context: Context, threadId: string): Response {
  return respondWithApiError(context, 404, "not_found", `There is no thread "${threadId}".`);
}

/** The parsed body, or undefined when it is not JSON, which the schema then refuses. */
async function readJsonBody(context: Context): Promise<unknown> {
  try {
    const body: unknown = await context.req.json();
    return body;
  } catch {
    return undefined;
  }
}

function respondUnavailable(context: Context, message: string): Response {
  return respondWithApiError(context, 503, "unavailable", `${message} Try again later.`);
}
