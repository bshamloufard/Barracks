import { readFileSync } from "node:fs";
import {
  type CatalogueProvider,
  generatedModelCatalogueSchema,
  type ModelCatalogue,
} from "@barrack/protocol";
import { catalogueFileUrl } from "./catalogue-file.js";
import { isRelayedProvider } from "./relayed-providers.js";

export {
  type AgentRequestShape,
  findAgentRequestShape,
  isAllowedValue,
} from "./agent-request-shapes.js";
export type { MemberRule, ObjectType } from "./agent-request-shapes-file.js";
export { findLargestMaxOutputTokens, findModelLimits } from "./model-limits.js";
export type { ModelLimits } from "./model-limits-file.js";
export {
  findRelayedProvider,
  isRelayedProvider,
  type ProviderApiFormat,
  type RelayedProvider,
  type RelayedProviderApi,
  relayedProviders,
} from "./relayed-providers.js";

const generatedCatalogue = generatedModelCatalogueSchema.parse(
  JSON.parse(readFileSync(catalogueFileUrl, "utf8")),
);

/**
 * The providers the agent can use with an API key and the models it lists
 * for each, generated from the pinned agent (see `scripts/`), each with
 * where its key lives (`relayed-providers.ts`). Read and checked once, when
 * first imported.
 */
export const modelCatalogue: ModelCatalogue = {
  agent: generatedCatalogue.agent,
  providers: generatedCatalogue.providers.map((provider) => ({
    ...provider,
    keyPlacement: isRelayedProvider(provider.providerId) ? "kept_on_server" : "placed_in_sandbox",
  })),
};

const providersById = new Map(
  modelCatalogue.providers.map((provider) => [provider.providerId, provider]),
);

/** The catalogued provider, or undefined for one the catalogue does not list. */
export function findCatalogueProvider(providerId: string): CatalogueProvider | undefined {
  return providersById.get(providerId);
}
