import {
  apiErrorResponseSchema,
  buildModelCredentialApiPath,
  type ModelCatalogue,
  type ModelCredentialSummary,
  modelCatalogueApiPath,
  modelCatalogueSchema,
  modelCredentialListResponseSchema,
  modelCredentialResponseSchema,
  modelCredentialsApiPath,
} from "@barrack/protocol";
import type { AuthorizedFetch } from "./authorized-fetch";

/**
 * The control plane's model access API: the catalogue of what the agent
 * supports, and the signed-in user's own keys. A key goes out to be saved
 * and never comes back; the page only ever learns that one exists, when it
 * was added and its last four characters.
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
    return (await readAnswer(response, modelCredentialListResponseSchema, "read your keys"))
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
    return (await readAnswer(response, modelCredentialResponseSchema, "save your key")).credential;
  }

  async removeCredential(providerId: string): Promise<ModelCredentialSummary[]> {
    const response = await this.#request(buildModelCredentialApiPath(providerId), {
      method: "DELETE",
    });
    return (await readAnswer(response, modelCredentialListResponseSchema, "remove your key"))
      .credentials;
  }

  async #fetchCatalogue(): Promise<ModelCatalogue> {
    const response = await this.#request(modelCatalogueApiPath);
    return readAnswer(response, modelCatalogueSchema, "read which models can be used");
  }
}

type AnswerSchema<Answer> = {
  safeParse(value: unknown): { success: true; data: Answer } | { success: false };
};

async function readAnswer<Answer>(
  response: Response,
  schema: AnswerSchema<Answer>,
  attempt: string,
): Promise<Answer> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const apiError = apiErrorResponseSchema.safeParse(body);
    const explanation = apiError.success ? apiError.data.error.message : `HTTP ${response.status}`;
    throw new Error(`Could not ${attempt}: ${explanation}`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `Could not ${attempt}: the control plane answered in a way this page does not understand. Reload the page.`,
    );
  }
  return parsed.data;
}
