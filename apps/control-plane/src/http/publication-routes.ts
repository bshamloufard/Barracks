import {
  parsePublicationBundleUploadPath,
  publishThreadRequestSchema,
  threadIdSchema,
  threadsApiPath,
} from "@barrack/protocol";
import type { Context, Hono } from "hono";
import type { Logger } from "../logger.js";
import type { PublicationBundleUploads } from "../publication/publication-bundle-uploads.js";
import type { ThreadPublisher } from "../publication/thread-publisher.js";
import type { SupervisorAuthorization } from "../websocket/supervisor-authorization.js";
import { respondWithApiError } from "./api-error.js";
import { limitBodySize, readJsonBody, respondUnavailable } from "./request-bodies.js";
import { requireJsonBody } from "./request-guards.js";
import { type SignedInEnvironment, signedInUserOf } from "./require-signed-in-user.js";

export type PublicationRoutesDependencies = {
  publisher: ThreadPublisher;
  uploads: PublicationBundleUploads;
  authorizeSupervisor: SupervisorAuthorization;
  logger: Logger;
};

/** Where supervisors upload bundles; outside `/api`, since a supervisor is not a signed-in user. */
export const publicationBundleUploadRoute =
  "/threads/:threadId/supervisor/publication-bundles/:publicationId";

/**
 * Publishing a thread's work branch, for its owner (behind
 * `requireSignedInUser`), and the upload through which the thread's
 * supervisor hands over the bundle that publishing asked it for, with the
 * thread's own supervisor token.
 */
export function addPublicationRoutes(
  app: Hono<SignedInEnvironment>,
  dependencies: PublicationRoutesDependencies,
): void {
  app.post(
    `${threadsApiPath}/:threadId/publication`,
    requireJsonBody(),
    limitBodySize(),
    (context) => publishThread(context, context.req.param("threadId"), dependencies),
  );
  app.put(publicationBundleUploadRoute, (context) => receiveBundle(context, dependencies));
}

async function publishThread(
  context: Context<SignedInEnvironment>,
  threadId: string,
  dependencies: PublicationRoutesDependencies,
): Promise<Response> {
  const request = publishThreadRequestSchema.safeParse(await readJsonBody(context));
  if (!request.success) {
    return respondWithApiError(
      context,
      400,
      "bad_request",
      'A thread is published with { "openPullRequest": true } or { "openPullRequest": false } as the body.',
    );
  }
  if (!threadIdSchema.safeParse(threadId).success) {
    return respondWithApiError(context, 404, "not_found", `There is no thread "${threadId}".`);
  }
  const { userId } = signedInUserOf(context);
  try {
    const outcome = await dependencies.publisher.publish(userId, threadId, request.data);
    switch (outcome.kind) {
      case "published":
        return context.json(outcome.publication);
      case "not_found":
        return respondWithApiError(context, 404, "not_found", `There is no thread "${threadId}".`);
      case "conflict":
        return respondWithApiError(context, 409, "conflict", outcome.message);
      case "failed":
        return respondWithApiError(context, 409, "publication_failed", outcome.message);
    }
  } catch (error) {
    dependencies.logger.error({ err: error, threadId }, "Could not publish a thread's branch");
    return respondUnavailable(context, "The control plane could not publish the thread's branch.");
  }
}

/**
 * Takes a bundle only from the supervisor of the thread it is for (its
 * token, compared as for its WebSocket), and only for a publication waiting
 * for it. Answers carry no detail a sandbox could learn anything from.
 */
async function receiveBundle(
  context: Context,
  dependencies: PublicationRoutesDependencies,
): Promise<Response> {
  const path = parsePublicationBundleUploadPath(context.req.path);
  if (!path.ok) {
    return context.text("Not found.", 404);
  }
  const { threadId, publicationId } = path.value;
  let isAuthorized: boolean;
  try {
    isAuthorized = await dependencies.authorizeSupervisor({
      threadId,
      authorizationHeader: context.req.header("authorization"),
    });
  } catch (error) {
    dependencies.logger.error(
      { err: error, threadId },
      "Could not check a bundle upload's credentials",
    );
    return context.text("The control plane cannot check credentials now.", 503);
  }
  if (!isAuthorized) {
    dependencies.logger.warn(
      { threadId },
      "Refused a bundle upload with missing or wrong credentials",
    );
    context.header("WWW-Authenticate", "Bearer");
    return context.text("Missing or wrong supervisor credentials.", 401);
  }
  const outcome = await dependencies.uploads.receive(threadId, publicationId, context.req.raw.body);
  switch (outcome.kind) {
    case "received":
      return context.text("Received.", 200);
    case "not_expected":
      return context.text("No such bundle is expected.", 404);
    case "too_large":
      return context.text("The bundle is too large.", 413);
    case "failed":
      dependencies.logger.warn({ threadId, reason: outcome.reason }, "A bundle upload broke off");
      return context.text("The upload failed.", 400);
  }
}
