import {
  changeOwnUsageCapRequestSchema,
  modelUsageApiPath,
  ownUsageCapApiPath,
  type ThreadModelUsageResponse,
  threadIdSchema,
  threadsApiPath,
} from "@barrack/protocol";
import type { Context, Hono } from "hono";
import type { Logger } from "../logger.js";
import type { ModelUsage } from "../model-usage/model-usage.js";
import type { ThreadStore } from "../threads/thread-store.js";
import { respondWithApiError } from "./api-error.js";
import { limitBodySize, readJsonBody, respondUnavailable } from "./request-bodies.js";
import { requireJsonBody } from "./request-guards.js";
import { type SignedInEnvironment, signedInUserOf } from "./require-signed-in-user.js";

export type ModelUsageRoutesDependencies = {
  usage: ModelUsage;
  threadStore: ThreadStore;
  logger: Logger;
};

/**
 * The signed-in user's model usage, described in `@barrack/protocol`'s
 * `model-usage.ts`: their recent totals and cap, a thread's totals (their
 * own thread's only), and the cap they set on themselves.
 */
export function addModelUsageRoutes(
  app: Hono<SignedInEnvironment>,
  dependencies: ModelUsageRoutesDependencies,
): void {
  app.get(modelUsageApiPath, (context) => describeUserUsage(context, dependencies));
  app.put(ownUsageCapApiPath, requireJsonBody(), limitBodySize(), (context) =>
    changeOwnCap(context, dependencies),
  );
  app.get(`${threadsApiPath}/:threadId/model-usage`, (context) =>
    describeThreadUsage(context, context.req.param("threadId"), dependencies),
  );
}

async function describeUserUsage(
  context: Context<SignedInEnvironment>,
  dependencies: ModelUsageRoutesDependencies,
): Promise<Response> {
  const { userId } = signedInUserOf(context);
  try {
    return context.json(await dependencies.usage.describeForUser(userId));
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not read a user's model usage");
    return respondUnavailable(context, "The control plane could not read your usage.");
  }
}

async function changeOwnCap(
  context: Context<SignedInEnvironment>,
  dependencies: ModelUsageRoutesDependencies,
): Promise<Response> {
  const request = changeOwnUsageCapRequestSchema.safeParse(await readJsonBody(context));
  if (!request.success) {
    return respondWithApiError(
      context,
      400,
      "bad_request",
      'Your own cap is set with { "tokens": <a whole number of tokens> }, or removed with { "tokens": null }.',
    );
  }
  const { userId } = signedInUserOf(context);
  try {
    const outcome = await dependencies.usage.setOwnCap(userId, request.data.tokens ?? undefined);
    if (!outcome.ok) {
      return respondWithApiError(context, 400, "bad_request", outcome.reason);
    }
    return context.json(await dependencies.usage.describeForUser(userId));
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not change a user's own usage cap");
    return respondUnavailable(context, "The control plane could not change your cap.");
  }
}

async function describeThreadUsage(
  context: Context<SignedInEnvironment>,
  threadId: string,
  dependencies: ModelUsageRoutesDependencies,
): Promise<Response> {
  const { userId } = signedInUserOf(context);
  const notFound = () =>
    respondWithApiError(context, 404, "not_found", `There is no thread "${threadId}".`);
  if (!threadIdSchema.safeParse(threadId).success) {
    return notFound();
  }
  try {
    if ((await dependencies.threadStore.findOwnedBy(userId, threadId)) === undefined) {
      return notFound();
    }
    const response: ThreadModelUsageResponse = {
      byModel: await dependencies.usage.listForThread(userId, threadId),
    };
    return context.json(response);
  } catch (error) {
    dependencies.logger.error({ err: error, threadId }, "Could not read a thread's model usage");
    return respondUnavailable(context, "The control plane could not read the thread's usage.");
  }
}
