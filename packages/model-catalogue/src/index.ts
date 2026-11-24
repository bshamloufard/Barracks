import { readFileSync } from "node:fs";
import {
  type CatalogueProvider,
  type ModelCatalogue,
  modelCatalogueSchema,
} from "@barrack/protocol";
import { catalogueFileUrl } from "./catalogue-file.js";

/**
 * The providers the agent can use with an API key and the models it lists
 * for each, generated from the pinned agent (see `scripts/`). Read and
 * checked once, when first imported.
 */
export const modelCatalogue: ModelCatalogue = modelCatalogueSchema.parse(
  JSON.parse(readFileSync(catalogueFileUrl, "utf8")),
);

const providersById = new Map(
  modelCatalogue.providers.map((provider) => [provider.providerId, provider]),
);

/** The catalogued provider, or undefined for one the catalogue does not list. */
export function findCatalogueProvider(providerId: string): CatalogueProvider | undefined {
  return providersById.get(providerId);
}
