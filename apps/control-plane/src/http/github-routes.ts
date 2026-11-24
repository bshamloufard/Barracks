import {
  finishGithubConnectionRequestSchema,
  type GithubConnectionResponse,
  githubConnectionApiPath,
  githubConnectionAttemptsApiPath,
  type StartGithubConnectionResponse,
  startGithubConnectionRequestSchema,
} from "@barrack/protocol";
import type { Context, Hono } from "hono";
import type { GithubConnections } from "../github/github-connections.js";
import type { Logger } from "../logger.js";
import { respondWithApiError } from "./api-error.js";
import { limitBodySize, readJsonBody, respondUnavailable } from "./request-bodies.js";
import { requireJsonBody } from "./request-guards.js";
import { type SignedInEnvironment, signedInUserOf } from "./require-signed-in-user.js";

export type GithubRoutesDependencies = {
  githubConnections: GithubConnections;
  logger: Logger;
};

/**
 * The GitHub link API (described in `@barrack/protocol`'s
 * `github-connection-api.ts`), always about the signed-in user's own link,
 * behind `requireSignedInUser` like every API route. The callback from
 * GitHub is a page of the web client, not a route here: it hands the code
 * and state to `POST /api/github/connection` with the user's access token,
 * which is what ties the link to the user who started it.
 */
export function addGithubRoutes(
  app: Hono<SignedInEnvironment>,
  dependencies: GithubRoutesDependencies,
): void {
  app.get(githubConnectionApiPath, (context) => describeConnection(context, dependencies));
  app.post(githubConnectionAttemptsApiPath, requireJsonBody(), limitBodySize(), (context) =>
    startConnecting(context, dependencies),
  );
  app.post(githubConnectionApiPath, requireJsonBody(), limitBodySize(), (context) =>
    finishConnecting(context, dependencies),
  );
  app.delete(githubConnectionApiPath, (context) => disconnect(context, dependencies));
}

async function describeConnection(
  context: Context<SignedInEnvironment>,
  dependencies: GithubRoutesDependencies,
): Promise<Response> {
  const { userId } = signedInUserOf(context);
  try {
    const response: GithubConnectionResponse = {
      connection: await dependencies.githubConnections.describe(userId),
    };
    return context.json(response);
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not read a GitHub link");
    return respondUnavailable(context, "The control plane could not read your GitHub link.");
  }
}

async function startConnecting(
  context: Context<SignedInEnvironment>,
  dependencies: GithubRoutesDependencies,
): Promise<Response> {
  if (!startGithubConnectionRequestSchema.safeParse(await readJsonBody(context)).success) {
    return respondWithApiError(
      context,
      400,
      "bad_request",
      "Start connecting with {} as the body.",
    );
  }
  const { userId } = signedInUserOf(context);
  try {
    const authorizationUrl = await dependencies.githubConnections.start(userId);
    if (authorizationUrl === undefined) {
      return respondWithApiError(
        context,
        409,
        "conflict",
        "GitHub is not set up on this installation of Barrack.",
      );
    }
    const response: StartGithubConnectionResponse = { authorizationUrl };
    return context.json(response, 201);
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not start linking GitHub");
    return respondUnavailable(context, "The control plane could not start connecting GitHub.");
  }
}

async function finishConnecting(
  context: Context<SignedInEnvironment>,
  dependencies: GithubRoutesDependencies,
): Promise<Response> {
  const request = finishGithubConnectionRequestSchema.safeParse(await readJsonBody(context));
  if (!request.success) {
    return respondWithApiError(
      context,
      400,
      "bad_request",
      'Finish connecting with the code and state GitHub returned: { "code", "state" }.',
    );
  }
  const { userId } = signedInUserOf(context);
  try {
    const outcome = await dependencies.githubConnections.finish(
      userId,
      request.data.code,
      request.data.state,
    );
    if (!outcome.ok) {
      return outcome.reason === "attempt_not_valid"
        ? respondWithApiError(context, 400, "bad_request", outcome.message)
        : respondWithApiError(context, 503, "unavailable", outcome.message);
    }
    const response: GithubConnectionResponse = { connection: outcome.connection };
    return context.json(response);
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not finish linking GitHub");
    return respondUnavailable(context, "The control plane could not finish connecting GitHub.");
  }
}

async function disconnect(
  context: Context<SignedInEnvironment>,
  dependencies: GithubRoutesDependencies,
): Promise<Response> {
  const { userId } = signedInUserOf(context);
  try {
    await dependencies.githubConnections.forget(userId);
    const response: GithubConnectionResponse = {
      connection: await dependencies.githubConnections.describe(userId),
    };
    return context.json(response);
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not forget a GitHub link");
    return respondUnavailable(context, "The control plane could not disconnect GitHub.");
  }
}
