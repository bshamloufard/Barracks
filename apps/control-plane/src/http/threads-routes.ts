import {
  createThreadRequestSchema,
  type ThreadListResponse,
  type ThreadResponse,
  type ThreadSummary,
  threadIdSchema,
  threadsApiPath,
} from "@barrack/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "../logger.js";
import type { ThreadCreator } from "../threads/thread-creator.js";
import type { ThreadRecord, ThreadStore } from "../threads/thread-store.js";
import { respondWithApiError } from "./api-error.js";
import { guardStateChangingRequests } from "./state-changing-request-guard.js";

export type ThreadsRoutesDependencies = {
  threadStore: ThreadStore;
  threadCreator: ThreadCreator;
  allowedClientOrigins: ReadonlySet<string>;
  logger: Logger;
};

/**
 * The thread list has no paging yet; this many is far more than one person
 * works through before sign-in and stopping threads arrive.
 */
const listedThreadLimit = 100;

/** A new thread's body is `{}`; anything much larger is not a request this API understands. */
const maximumRequestBodyInBytes = 16 * 1024;

/**
 * `POST /api/threads` creates a thread, `GET /api/threads` lists the newest,
 * and `GET /api/threads/{threadId}` fetches one. Shapes are in
 * `@barrack/protocol` (`threads-api.ts`).
 */
export function addThreadsRoutes(app: Hono, dependencies: ThreadsRoutesDependencies): void {
  app.post(
    threadsApiPath,
    guardStateChangingRequests(dependencies.allowedClientOrigins),
    bodyLimit({
      maxSize: maximumRequestBodyInBytes,
      onError: (context) =>
        respondWithApiError(context, 413, "payload_too_large", "The request body is too large."),
    }),
    (context) => createThread(context, dependencies),
  );
  app.get(threadsApiPath, (context) => listThreads(context, dependencies));
  app.get(`${threadsApiPath}/:threadId`, (context) =>
    fetchThread(context, context.req.param("threadId"), dependencies),
  );
}

async function createThread(
  context: Context,
  dependencies: ThreadsRoutesDependencies,
): Promise<Response> {
  const body = await readJsonBody(context);
  if (!createThreadRequestSchema.safeParse(body).success) {
    return respondWithApiError(
      context,
      400,
      "bad_request",
      "A new thread is created with an empty JSON object, {}, as the body.",
    );
  }
  try {
    const thread = await dependencies.threadCreator.createThread();
    const response: ThreadResponse = { thread: toThreadSummary(thread) };
    return context.json(response, 201);
  } catch (error) {
    dependencies.logger.error({ err: error }, "Could not create a thread");
    return respondUnavailable(context, "The control plane could not record a new thread.");
  }
}

async function listThreads(
  context: Context,
  dependencies: ThreadsRoutesDependencies,
): Promise<Response> {
  try {
    const threads = await dependencies.threadStore.listNewestFirst(listedThreadLimit);
    const response: ThreadListResponse = { threads: threads.map(toThreadSummary) };
    return context.json(response);
  } catch (error) {
    dependencies.logger.error({ err: error }, "Could not list threads");
    return respondUnavailable(context, "The control plane could not read its threads.");
  }
}

async function fetchThread(
  context: Context,
  threadId: string,
  dependencies: ThreadsRoutesDependencies,
): Promise<Response> {
  const notFound = () =>
    respondWithApiError(context, 404, "not_found", `There is no thread "${threadId}".`);
  if (!threadIdSchema.safeParse(threadId).success) {
    return notFound();
  }
  try {
    const thread = await dependencies.threadStore.find(threadId);
    return thread === undefined ? notFound() : context.json({ thread: toThreadSummary(thread) });
  } catch (error) {
    dependencies.logger.error({ err: error, threadId }, "Could not read a thread");
    return respondUnavailable(context, "The control plane could not read the thread.");
  }
}

/** What clients may see of a thread: never its token digest, provider or sandbox identifier. */
function toThreadSummary(thread: ThreadRecord): ThreadSummary {
  const { sandbox } = thread;
  return {
    threadId: thread.threadId,
    createdAt: thread.createdAt.toISOString(),
    sandbox:
      sandbox.state === "failed"
        ? { state: "failed", reason: sandbox.reason }
        : { state: sandbox.state },
  };
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
