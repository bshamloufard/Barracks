import {
  type CatalogueProvider,
  type ModelCatalogue,
  type ModelCredentialSummary,
  modelReferenceSchema,
  parseModelReference,
} from "@barrack/protocol";

/** A provider the user can pick a model from, with or without their key for it. */
export type ProviderChoice = {
  providerId: string;
  name: string;
  hasKey: boolean;
  /** Undefined for a provider the catalogue does not list, which the user added a key for themselves. */
  catalogued: CatalogueProvider | undefined;
};

/**
 * The providers to offer, those the user has a key for first, then the
 * catalogue's in its own order (the common ones lead it).
 */
export function listProviderChoices(
  catalogue: ModelCatalogue,
  credentials: readonly ModelCredentialSummary[],
): ProviderChoice[] {
  const keyedIds = new Set(credentials.map((credential) => credential.providerId));
  const catalogued: ProviderChoice[] = catalogue.providers.map((provider) => ({
    providerId: provider.providerId,
    name: provider.name,
    hasKey: keyedIds.has(provider.providerId),
    catalogued: provider,
  }));
  const uncatalogued: ProviderChoice[] = credentials
    .filter(
      (credential) => !catalogued.some((choice) => choice.providerId === credential.providerId),
    )
    .map((credential) => ({
      providerId: credential.providerId,
      name: credential.providerId,
      hasKey: true,
      catalogued: undefined,
    }));
  const all = [...uncatalogued, ...catalogued];
  return [...all.filter((choice) => choice.hasKey), ...all.filter((choice) => !choice.hasKey)];
}

/** A model to start the choice on: the first listed model of the first provider the user has a key for. */
export function suggestModel(choices: readonly ProviderChoice[]): string | undefined {
  const keyed = choices.find((choice) => choice.hasKey);
  if (keyed === undefined) {
    return undefined;
  }
  const firstModel = keyed.catalogued?.models[0];
  return firstModel === undefined ? undefined : `${keyed.providerId}/${firstModel.modelId}`;
}

/**
 * Why a model cannot be chosen yet, for the user, or undefined if it can:
 * a reference that is not `provider/model`, or a provider with no key.
 */
export function describeWhyModelCannotRun(
  model: string,
  choices: readonly ProviderChoice[],
): string | undefined {
  if (!modelReferenceSchema.safeParse(model).success) {
    return 'Enter the model as "provider/model", such as "anthropic/<model id>".';
  }
  const { providerId } = parseModelReference(model);
  const choice = choices.find((candidate) => candidate.providerId === providerId);
  if (choice?.hasKey) {
    return undefined;
  }
  const keyName = choice?.catalogued?.secretLabel ?? `key for "${providerId}"`;
  return `You have no ${keyName}. Add one in Settings to use this model.`;
}

/** "Model A (anthropic/model-a)", or the reference alone for a model the catalogue does not list. */
export function describeModel(model: string, catalogue: ModelCatalogue | undefined): string {
  if (!modelReferenceSchema.safeParse(model).success) {
    return model;
  }
  const { providerId, modelId } = parseModelReference(model);
  const provider = catalogue?.providers.find((candidate) => candidate.providerId === providerId);
  const listed = provider?.models.find((candidate) => candidate.modelId === modelId);
  return listed === undefined ? model : `${listed.name} (${model})`;
}
