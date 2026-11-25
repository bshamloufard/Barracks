import {
  type ChatGptPlanDisconnection,
  type ChatGptPlanModelList,
  changeOpenAiAccessRequestSchema,
  chatGptPlanApiPath,
  chatGptPlanModelsApiPath,
  chatGptPlanOpenAiAccessApiPath,
  chatGptPlanSignInApiPath,
  chatGptPlanSignInCompletionApiPath,
  completeChatGptPlanSignInRequestSchema,
  startChatGptPlanSignInRequestSchema,
} from "@barrack/protocol";
import type { Context, Hono } from "hono";
import {
  type ChatGptPlanAccess,
  chatGptPlanProviderId,
} from "../chatgpt-plan/chatgpt-plan-access.js";
import type { ChatGptPlanModels } from "../chatgpt-plan/chatgpt-plan-models.js";
import type { ChatGptSignIn } from "../chatgpt-plan/chatgpt-sign-in.js";
import type { Logger } from "../logger.js";
import type { ModelAccessChanges } from "../model-access/model-access-changes.js";
import { respondWithApiError } from "./api-error.js";
import { limitBodySize, readJsonBody, respondUnavailable } from "./request-bodies.js";
import { requireJsonBody } from "./request-guards.js";
import { type SignedInEnvironment, signedInUserOf } from "./require-signed-in-user.js";

export type ChatGptPlanRoutesDependencies = {
  access: ChatGptPlanAccess;
  /** Undefined where the installation does not offer ChatGPT plans. */
  signIn: ChatGptSignIn | undefined;
  models: ChatGptPlanModels | undefined;
  changes: ModelAccessChanges;
  logger: Logger;
};

/**
 * The ChatGPT plan API (described in `@barrack/protocol`'s
 * `chatgpt-plan.ts`), for the signed-in user's own plan only: there is no
 * way to name another user's. No answer holds anything of a token; neither
 * the pasted address nor any request body is ever logged. Every change
 * that alters what a user's threads spend is passed on to those threads at
 * once, as a changed key is.
 */
export function addChatGptPlanRoutes(
  app: Hono<SignedInEnvironment>,
  dependencies: ChatGptPlanRoutesDependencies,
): void {
  app.get(chatGptPlanApiPath, (context) => describeStatus(context, dependencies));
  app.post(chatGptPlanSignInApiPath, requireJsonBody(), limitBodySize(), (context) =>
    startSignIn(context, dependencies),
  );
  app.post(chatGptPlanSignInCompletionApiPath, requireJsonBody(), limitBodySize(), (context) =>
    finishSignIn(context, dependencies),
  );
  app.delete(chatGptPlanApiPath, (context) => disconnect(context, dependencies));
  app.put(chatGptPlanOpenAiAccessApiPath, requireJsonBody(), limitBodySize(), (context) =>
    changeOpenAiAccess(context, dependencies),
  );
  app.get(chatGptPlanModelsApiPath, (context) => listModels(context, dependencies));
}

async function describeStatus(
  context: Context<SignedInEnvironment>,
  dependencies: ChatGptPlanRoutesDependencies,
): Promise<Response> {
  const { userId } = signedInUserOf(context);
  try {
    return context.json(await dependencies.access.describe(userId));
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not describe a user's ChatGPT plan");
    return respondUnavailable(context, "The control plane could not read your ChatGPT plan.");
  }
}

async function startSignIn(
  context: Context<SignedInEnvironment>,
  dependencies: ChatGptPlanRoutesDependencies,
): Promise<Response> {
  if (dependencies.signIn === undefined) {
    return refuseUnoffered(context);
  }
  const request = startChatGptPlanSignInRequestSchema.safeParse(await readJsonBody(context));
  if (!request.success) {
    return respondWithApiError(
      context,
      400,
      "bad_request",
      'A sign-in begins only with your consent to use your plan while you are away: { "allowsBackgroundUse": true }.',
    );
  }
  const { userId } = signedInUserOf(context);
  try {
    return context.json(await dependencies.signIn.start(userId));
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not begin a ChatGPT plan sign-in");
    return respondUnavailable(context, "OpenAI's sign-in could not be reached; try again shortly.");
  }
}

async function finishSignIn(
  context: Context<SignedInEnvironment>,
  dependencies: ChatGptPlanRoutesDependencies,
): Promise<Response> {
  if (dependencies.signIn === undefined) {
    return refuseUnoffered(context);
  }
  const request = completeChatGptPlanSignInRequestSchema.safeParse(await readJsonBody(context));
  if (!request.success) {
    return respondWithApiError(
      context,
      400,
      "bad_request",
      'A sign-in is finished with { "finalAddress": "<the address your browser ended on>" }.',
    );
  }
  const { userId } = signedInUserOf(context);
  try {
    await noteOpenAiAccessMayChange(dependencies, userId);
    const finish = await dependencies.signIn.finish(userId, request.data.finalAddress);
    if (finish.kind === "failed") {
      return respondWithApiError(context, 400, "chatgpt_sign_in_failed", finish.message);
    }
    await dependencies.changes.ownerCredentialsChanged(userId);
    return context.json(await dependencies.access.describe(userId));
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not finish a ChatGPT plan sign-in");
    return respondUnavailable(context, "The control plane could not finish your sign-in.");
  }
}

async function disconnect(
  context: Context<SignedInEnvironment>,
  dependencies: ChatGptPlanRoutesDependencies,
): Promise<Response> {
  const { userId } = signedInUserOf(context);
  try {
    await noteOpenAiAccessMayChange(dependencies, userId);
    const disconnection = await dependencies.access.disconnect(userId);
    if (disconnection === undefined) {
      return respondWithApiError(context, 404, "not_found", "No ChatGPT plan is connected.");
    }
    await dependencies.changes.ownerCredentialsChanged(userId);
    const response: ChatGptPlanDisconnection = {
      status: await dependencies.access.describe(userId),
      revocation: disconnection.revocation,
    };
    return context.json(response);
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not disconnect a ChatGPT plan");
    return respondUnavailable(context, "The control plane could not disconnect your plan.");
  }
}

async function changeOpenAiAccess(
  context: Context<SignedInEnvironment>,
  dependencies: ChatGptPlanRoutesDependencies,
): Promise<Response> {
  const request = changeOpenAiAccessRequestSchema.safeParse(await readJsonBody(context));
  if (!request.success) {
    return respondWithApiError(
      context,
      400,
      "bad_request",
      'Say what OpenAI models spend with { "access": "api_key" } or { "access": "chatgpt_plan" }.',
    );
  }
  const { userId } = signedInUserOf(context);
  try {
    await noteOpenAiAccessMayChange(dependencies, userId);
    if (!(await dependencies.access.setOpenAiAccess(userId, request.data.access))) {
      return refuseNotConnected(context);
    }
    await dependencies.changes.ownerCredentialsChanged(userId);
    return context.json(await dependencies.access.describe(userId));
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not change a user's OpenAI access");
    return respondUnavailable(context, "The control plane could not save your choice.");
  }
}

/**
 * Before what the user's OpenAI models spend may change, so their runs
 * open now carry on with what they began with (see
 * `ModelAccessChanges.openAiAccessMayChange`). Noted even if it then does
 * not change, which leaves those runs as they are.
 */
async function noteOpenAiAccessMayChange(
  dependencies: ChatGptPlanRoutesDependencies,
  userId: string,
): Promise<void> {
  const currentAccess = await dependencies.access.findAccess(userId, chatGptPlanProviderId);
  await dependencies.changes.openAiAccessMayChange(userId, currentAccess);
}

async function listModels(
  context: Context<SignedInEnvironment>,
  dependencies: ChatGptPlanRoutesDependencies,
): Promise<Response> {
  if (dependencies.models === undefined) {
    return refuseUnoffered(context);
  }
  const { userId } = signedInUserOf(context);
  try {
    const listing = await dependencies.models.list(userId);
    if (listing.kind === "not_connected") {
      return refuseNotConnected(context);
    }
    if (listing.kind === "unavailable") {
      return respondUnavailable(
        context,
        "OpenAI did not list your plan's models; try again shortly.",
      );
    }
    const response: ChatGptPlanModelList = { models: listing.models };
    return context.json(response);
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not list a ChatGPT plan's models");
    return respondUnavailable(
      context,
      "OpenAI did not list your plan's models; try again shortly.",
    );
  }
}

function refuseUnoffered(context: Context<SignedInEnvironment>): Response {
  return respondWithApiError(
    context,
    409,
    "chatgpt_plan_unavailable",
    "This installation does not offer ChatGPT plans: its operator has not turned them on.",
  );
}

function refuseNotConnected(context: Context<SignedInEnvironment>): Response {
  return respondWithApiError(
    context,
    409,
    "chatgpt_plan_not_connected",
    "Your ChatGPT plan is not connected. Connect it in Settings first.",
  );
}
