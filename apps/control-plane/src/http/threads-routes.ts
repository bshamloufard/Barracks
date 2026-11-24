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
import { requireJsonBody } from "./request-guards.js";
import { type SignedInEnvironment, signedInUserOf } from "./require-signed-in-user.js";

export type ThreadsRoutesDependencies = {
  threadStore: ThreadStore;
  threadCreator: ThreadCreator;
  logger: Logger;
};

/**
 * The thread list has no paging yet; this many is far more than one person
 * works through before stopping threads arrives.
 */
const listedThreadLimit = 100;

/** A new thread's body is `{}`; anything much larger is not a request this API understands. */
const maximumRequestBodyInBytes = 16 * 1024;

/**
 * `POST /api/threads` creates a thread, `GET /api/threads` lists the newest,
 * and `GET /api/threads/{threadId}` fetches one, always the signed-in user's
 * own: another user's thread is answered exactly as one that does not exist.
 * They sit behind `requireSignedInUser`. Shapes are in `@barrack/protocol`
 * (`threads-api.ts`).
 */
export function addThreadsRoutes(
  app: Hono<SignedInEnvironment>,
  dependencies: ThreadsRoutesDependencies,
): void {
  app.post(
    threadsApiPath,
    requireJsonBody(),
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
  context: Context<SignedInEnvironment>,
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
  const { userId } = signedInUserOf(context);
  try {
    const thread = await dependencies.threadCreator.createThread(userId);
    const response: ThreadResponse = { thread: toThreadSummary(thread) };
    return context.json(response, 201);
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
    const threads = await dependencies.threadStore.listNewestFirstOwnedBy(
      userId,
      listedThreadLimit,
    );
    const response: ThreadListResponse = { threads: threads.map(toThreadSummary) };
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
  const notFound = () =>
    respondWithApiError(context, 404, "not_found", `There is no thread "${threadId}".`);
  if (!threadIdSchema.safeParse(threadId).success) {
    return notFound();
  }
  const { userId } = signedInUserOf(context);
  try {
    const thread = await dependencies.threadStore.findOwnedBy(userId, threadId);
    return thread === undefined ? notFound() : context.json({ thread: toThreadSummary(thread) });
  } catch (error) {
    dependencies.logger.error({ err: error, threadId }, "Could not read a thread");
    return respondUnavailable(context, "The control plane could not read the thread.");
  }
}

/** What clients may see of a thread: never its token digest, owner, provider or sandbox identifier. */
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
