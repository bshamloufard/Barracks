import { modelCatalogue } from "@barrack/model-catalogue";
import {
  type ModelCredentialListResponse,
  type ModelCredentialResponse,
  modelCatalogueApiPath,
  modelCredentialsApiPath,
  saveModelCredentialRequestSchema,
} from "@barrack/protocol";
import type { Context, Hono } from "hono";
import type { Logger } from "../logger.js";
import type { ModelAccessChanges } from "../model-access/model-access-changes.js";
import type { ModelCredentialSummary } from "../model-access/model-credential-store.js";
import type { ModelCredentials } from "../model-access/model-credentials.js";
import { respondWithApiError } from "./api-error.js";
import { limitBodySize, readJsonBody, respondUnavailable } from "./request-bodies.js";
import { requireJsonBody } from "./request-guards.js";
import { type SignedInEnvironment, signedInUserOf } from "./require-signed-in-user.js";

export type ModelAccessRoutesDependencies = {
  credentials: ModelCredentials;
  changes: ModelAccessChanges;
  logger: Logger;
};

/**
 * The model access API (described in `@barrack/protocol`'s
 * `model-access.ts`): the catalogue of what the agent supports, and the
 * signed-in user's own keys. No answer ever holds a key: a key goes in, and
 * only that it exists, when it was added and its last four characters come
 * out. Keys are never logged; neither are request bodies here.
 */
export function addModelAccessRoutes(
  app: Hono<SignedInEnvironment>,
  dependencies: ModelAccessRoutesDependencies,
): void {
  app.get(modelCatalogueApiPath, (context) => context.json(modelCatalogue));
  app.get(modelCredentialsApiPath, (context) => listCredentials(context, dependencies));
  app.put(`${modelCredentialsApiPath}/:providerId`, requireJsonBody(), limitBodySize(), (context) =>
    saveCredential(context, context.req.param("providerId"), dependencies),
  );
  app.delete(`${modelCredentialsApiPath}/:providerId`, (context) =>
    removeCredential(context, context.req.param("providerId"), dependencies),
  );
}

async function listCredentials(
  context: Context<SignedInEnvironment>,
  dependencies: ModelAccessRoutesDependencies,
): Promise<Response> {
  const { userId } = signedInUserOf(context);
  try {
    return context.json(await describeCredentials(userId, dependencies));
  } catch (error) {
    dependencies.logger.error({ err: error, userId }, "Could not list a user's model credentials");
    return respondUnavailable(context, "The control plane could not read your keys.");
  }
}

async function saveCredential(
  context: Context<SignedInEnvironment>,
  providerId: string,
  dependencies: ModelAccessRoutesDependencies,
): Promise<Response> {
  const request = saveModelCredentialRequestSchema.safeParse(await readJsonBody(context));
  if (!request.success) {
    return respondWithApiError(
      context,
      400,
      "bad_request",
      'A key is saved with { "secret": "<the key>", "settings": { … } } as the body.',
    );
  }
  const { userId } = signedInUserOf(context);
  try {
    const outcome = await dependencies.credentials.save(userId, providerId, request.data);
    if (outcome.kind === "invalid") {
      return respondWithApiError(context, 400, "bad_request", outcome.message);
    }
    await dependencies.changes.ownerCredentialsChanged(userId);
    const response: ModelCredentialResponse = { credential: toSummary(outcome.credential) };
    return context.json(response);
  } catch (error) {
    dependencies.logger.error(
      { err: error, userId, providerId },
      "Could not save a model credential",
    );
    return respondUnavailable(context, "The control plane could not save your key.");
  }
}

async function removeCredential(
  context: Context<SignedInEnvironment>,
  providerId: string,
  dependencies: ModelAccessRoutesDependencies,
): Promise<Response> {
  const { userId } = signedInUserOf(context);
  try {
    if (!(await dependencies.credentials.remove(userId, providerId))) {
      return respondWithApiError(context, 404, "not_found", `You have no key for "${providerId}".`);
    }
    await dependencies.changes.ownerCredentialsChanged(userId);
    return context.json(await describeCredentials(userId, dependencies));
  } catch (error) {
    dependencies.logger.error(
      { err: error, userId, providerId },
      "Could not remove a model credential",
    );
    return respondUnavailable(context, "The control plane could not remove your key.");
  }
}

async function describeCredentials(
  userId: string,
  dependencies: ModelAccessRoutesDependencies,
): Promise<ModelCredentialListResponse> {
  const credentials = await dependencies.credentials.list(userId);
  return { credentials: credentials.map(toSummary) };
}

function toSummary(credential: ModelCredentialSummary): ModelCredentialResponse["credential"] {
  return {
    providerId: credential.providerId,
    addedAt: credential.addedAt.toISOString(),
    secretEnding: credential.secretEnding,
  };
}
