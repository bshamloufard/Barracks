import {
  changeThreadModelRequestSchema,
  createThreadRequestSchema,
  type ThreadListResponse,
  type ThreadResponse,
  type ThreadSandbox,
  type ThreadSummary,
  threadActionRequestSchema,
  threadIdSchema,
  threadsApiPath,
} from "@barrack/protocol";
import type { Context, Hono } from "hono";
import type { Logger } from "../logger.js";
import type { ModelAccessChanges } from "../model-access/model-access-changes.js";
import type { ModelCredentials } from "../model-access/model-credentials.js";
import { describePublishing } from "../publication/publishing-availability.js";
import type { RepositoryRequests } from "../repositories/repository-requests.js";
import type {
  ThreadRepositoryRecord,
  ThreadRepositoryStore,
} from "../repositories/thread-repository-store.js";
import type {
  LifecycleRequestOutcome,
  SandboxLifecycle,
} from "../sandbox-lifecycle/sandbox-lifecycle.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type { ThreadRecord, ThreadSandboxRecord, ThreadStore } from "../threads/thread-store.js";
import { respondWithApiError } from "./api-error.js";
import { limitBodySize, readJsonBody, respondUnavailable } from "./request-bodies.js";
import { requireJsonBody } from "./request-guards.js";
import { type SignedInEnvironment, signedInUserOf } from "./require-signed-in-user.js";

export type ThreadsRoutesDependencies = {
  threadStore: ThreadStore;
  threadEventLog: ThreadEventLog;
  sandboxLifecycle: SandboxLifecycle;
  repositories: ThreadRepositoriesDependencies;
  modelAccess: ThreadModelAccessDependencies;
  logger: Logger;
};

/** What choosing a thread's model needs. */
export type ThreadModelAccessDependencies = {
  credentials: ModelCredentials;
  changes: ModelAccessChanges;
  /** Whether a thread must have a model: the real agent needs one, the fake agent does not. */
  isModelRequired: boolean;
};

/** What creating threads on repositories, and describing them, needs. */
export type ThreadRepositoriesDependencies = {
  requests: RepositoryRequests;
  store: ThreadRepositoryStore;
  /** Whether this installation has a GitHub App, without which nothing can be published. */
  isGithubAvailable: boolean;
};

/**
 * The thread list has no paging yet; this many is far more than one person
 * keeps before deleting some.
 */
const listedThreadLimit = 100;

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
  app.put(`${threadsApiPath}/:threadId/model`, requireJsonBody(), limitBodySize(), (context) =>
    changeModel(context, context.req.param("threadId"), dependencies),
  );
}

async function createThread(
  context: Context<SignedInEnvironment>,
  dependencies: ThreadsRoutesDependencies,
): Promise<Response> {
  const request = createThreadRequestSchema.safeParse(await readJsonBody(context));
  if (!request.success) {
    return respondWithApiError(
      context,
      400,
      "bad_request",
      'A new thread is created with { "model": "provider/model" } as the body, and "repository": { "url", "access", "baseBranch" } to start from a repository.',
    );
  }
  const { userId } = signedInUserOf(context);
  try {
    const { model, repository } = request.data;
    const modelRefusal = await refuseModel(context, userId, model, dependencies);
    if (modelRefusal !== undefined) {
      return modelRefusal;
    }
    const resolved =
      repository === undefined
        ? undefined
        : await dependencies.repositories.requests.resolve(userId, repository);
    if (resolved?.kind === "invalid") {
      return respondWithApiError(context, 400, "bad_request", resolved.message);
    }
    if (resolved?.kind === "not_allowed") {
      return respondWithApiError(context, 403, "repository_not_allowed", resolved.message);
    }
    const outcome = await dependencies.sandboxLifecycle.createThread(userId, {
      model,
      repository: resolved?.choice,
    });
    return await respondToLifecycleRequest(context, outcome, 201, "", dependencies);
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not create a thread");
    return respondUnavailable(context, "The control plane could not record a new thread.");
  }
}

/**
 * Refuses a new thread without a model where the agent needs one, and with
 * a model whose provider the user has no key for, saying which key to add
 * and where; undefined when the model will do.
 */
async function refuseModel(
  context: Context,
  userId: string,
  model: string | undefined,
  dependencies: ThreadsRoutesDependencies,
): Promise<Response | undefined> {
  const { credentials, isModelRequired } = dependencies.modelAccess;
  if (model === undefined) {
    return isModelRequired
      ? respondWithApiError(
          context,
          400,
          "bad_request",
          'Choose a model for the thread: { "model": "provider/model" }.',
        )
      : undefined;
  }
  const missing = await credentials.describeMissingCredential(
    userId,
    model,
    "create the thread again",
  );
  return missing === undefined
    ? undefined
    : respondWithApiError(context, 409, "model_credential_missing", missing);
}

/** The new model applies from the agent's next run; its supervisor is told at once. */
async function changeModel(
  context: Context<SignedInEnvironment>,
  threadId: string,
  dependencies: ThreadsRoutesDependencies,
): Promise<Response> {
  const request = changeThreadModelRequestSchema.safeParse(await readJsonBody(context));
  if (!request.success) {
    return respondWithApiError(
      context,
      400,
      "bad_request",
      'A thread\'s model is changed with { "model": "provider/model" } as the body.',
    );
  }
  if (!threadIdSchema.safeParse(threadId).success) {
    return respondThreadNotFound(context, threadId);
  }
  const { userId } = signedInUserOf(context);
  const { model } = request.data;
  const { credentials, changes } = dependencies.modelAccess;
  try {
    const owned = await dependencies.threadStore.findOwnedBy(userId, threadId);
    if (owned === undefined) {
      return respondThreadNotFound(context, threadId);
    }
    const missing = await credentials.describeMissingCredential(userId, model, "switch again");
    if (missing !== undefined) {
      return respondWithApiError(context, 409, "model_credential_missing", missing);
    }
    const thread = await changes.switchThreadModel(userId, threadId, owned.model, model);
    if (thread === undefined) {
      return respondThreadNotFound(context, threadId);
    }
    dependencies.logger.info({ threadId, model }, "Switched a thread's model");
    return await respondWithThread(context, thread, 200, dependencies);
  } catch (error) {
    dependencies.logger.error({ err: error, threadId }, "Could not switch a thread's model");
    return respondUnavailable(context, "The control plane could not switch the thread's model.");
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
      threads: await toThreadSummaries(threads, dependencies),
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
  const [summary] = await toThreadSummaries([thread], dependencies);
  const response: ThreadResponse = {
    thread: summary ?? toThreadSummary(thread, false, undefined, false),
  };
  return context.json(response, status);
}

/**
 * Whether each agent is working, and each thread's repository, are read for
 * all of them at once, without reading events.
 */
async function toThreadSummaries(
  threads: ThreadRecord[],
  dependencies: Pick<ThreadsRoutesDependencies, "threadEventLog" | "repositories">,
): Promise<ThreadSummary[]> {
  const threadIds = threads.map((thread) => thread.threadId);
  const [working, repositories] = await Promise.all([
    dependencies.threadEventLog.findThreadsWithOpenRuns(threadIds),
    dependencies.repositories.store.findMany(threadIds),
  ]);
  return threads.map((thread) =>
    toThreadSummary(
      thread,
      working.has(thread.threadId),
      repositories.get(thread.threadId),
      dependencies.repositories.isGithubAvailable,
    ),
  );
}

/** What clients may see of a thread: never its token digest, owner, provider or sandbox identifier. */
function toThreadSummary(
  thread: ThreadRecord,
  isAgentWorking: boolean,
  repository: ThreadRepositoryRecord | undefined,
  isGithubAvailable: boolean,
): ThreadSummary {
  return {
    threadId: thread.threadId,
    createdAt: thread.createdAt.toISOString(),
    lastActiveAt: thread.lastActivityAt.toISOString(),
    title: thread.title ?? null,
    isAgentWorking,
    sandbox: toSandboxSummary(thread.sandbox),
    repository:
      repository === undefined
        ? null
        : {
            url: repository.url,
            access: repository.access,
            baseBranch: repository.baseBranch ?? null,
            workBranch: repository.workBranch,
            publishing: describePublishing(repository, isGithubAvailable),
          },
    model: thread.model ?? null,
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
