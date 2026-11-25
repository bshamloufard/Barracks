import {
  buildModelCredentialApiPath,
  buildThreadModelUsageApiPath,
  type ModelCatalogue,
  type ModelCredentialSummary,
  modelCatalogueApiPath,
  modelCatalogueSchema,
  modelCredentialListResponseSchema,
  modelCredentialResponseSchema,
  modelCredentialsApiPath,
  modelUsageApiPath,
  ownUsageCapApiPath,
  type ThreadModelUsageResponse,
  threadModelUsageResponseSchema,
  type UserModelUsageResponse,
  userModelUsageResponseSchema,
} from "@barrack/protocol";
import type { AuthorizedFetch } from "./authorized-fetch";
import { readApiAnswer } from "./read-api-answer";

/**
 * The control plane's model access API: the catalogue of what the agent
 * supports, the signed-in user's own keys, and what their threads have used.
 * A key goes out to be saved and never comes back; the page only ever
 * learns that one exists, when it was added and its last four characters.
 */
export class ModelAccessApi {
  readonly #request: AuthorizedFetch;
  #catalogue: Promise<ModelCatalogue> | undefined;

  constructor(request: AuthorizedFetch) {
    this.#request = request;
  }

  /** Fetched once per page: it changes only with a new release of the agent. */
  readCatalogue(): Promise<ModelCatalogue> {
    this.#catalogue ??= this.#fetchCatalogue().catch((error: unknown) => {
      this.#catalogue = undefined;
      throw error;
    });
    return this.#catalogue;
  }

  async listCredentials(): Promise<ModelCredentialSummary[]> {
    const response = await this.#request(modelCredentialsApiPath);
    return (await readApiAnswer(response, modelCredentialListResponseSchema, "read your keys"))
      .credentials;
  }

  async saveCredential(
    providerId: string,
    secret: string,
    settings: Record<string, string>,
  ): Promise<ModelCredentialSummary> {
    const response = await this.#request(buildModelCredentialApiPath(providerId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, settings }),
    });
    return (await readApiAnswer(response, modelCredentialResponseSchema, "save your key"))
      .credential;
  }

  async removeCredential(providerId: string): Promise<ModelCredentialSummary[]> {
    const response = await this.#request(buildModelCredentialApiPath(providerId), {
      method: "DELETE",
    });
    return (await readApiAnswer(response, modelCredentialListResponseSchema, "remove your key"))
      .credentials;
  }

  async readUsage(): Promise<UserModelUsageResponse> {
    const response = await this.#request(modelUsageApiPath);
    return readApiAnswer(response, userModelUsageResponseSchema, "read your usage");
  }

  /** Sets the user's own cap, or removes it with null; answers with their usage as it now stands. */
  async changeOwnCap(tokens: number | null): Promise<UserModelUsageResponse> {
    const response = await this.#request(ownUsageCapApiPath, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens }),
    });
    return readApiAnswer(response, userModelUsageResponseSchema, "change your cap");
  }

  async readThreadUsage(threadId: string): Promise<ThreadModelUsageResponse> {
    const response = await this.#request(buildThreadModelUsageApiPath(threadId));
    return readApiAnswer(response, threadModelUsageResponseSchema, "read this thread's usage");
  }

  async #fetchCatalogue(): Promise<ModelCatalogue> {
    const response = await this.#request(modelCatalogueApiPath);
    return readApiAnswer(response, modelCatalogueSchema, "read which models can be used");
  }
}
