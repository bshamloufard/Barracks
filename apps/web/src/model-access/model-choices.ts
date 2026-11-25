import {
  type CatalogueProvider,
  type ChatGptPlanModel,
  type ModelCatalogue,
  type ModelCredentialSummary,
  modelReferenceSchema,
  parseModelReference,
} from "@barrack/protocol";

/** A provider the user can pick a model from, with or without their key (or plan) for it. */
export type ProviderChoice = {
  providerId: string;
  name: string;
  /** Whether the user can run its models now: their key, or for OpenAI their connected plan. */
  hasKey: boolean;
  /** Undefined for a provider the catalogue does not list, which the user added a key for themselves. */
  catalogued: CatalogueProvider | undefined;
  /** For OpenAI when its models run on the user's ChatGPT plan: the models the plan offers. */
  planModels: ChatGptPlanModel[] | undefined;
};

/** The user's ChatGPT plan, where their OpenAI models run on it. */
export type PlanInUse = { isConnected: boolean; models: ChatGptPlanModel[] };

/** The provider whose models can run on a ChatGPT plan. */
const planProviderId = "openai";

/**
 * The providers to offer, those the user can run first, then the
 * catalogue's in its own order (the common ones lead it). Where the user's
 * OpenAI models run on their ChatGPT plan (`plan`), OpenAI is runnable while
 * the plan is connected, with the plan's models.
 */
export function listProviderChoices(
  catalogue: ModelCatalogue,
  credentials: readonly ModelCredentialSummary[],
  plan: PlanInUse | undefined = undefined,
): ProviderChoice[] {
  const keyedIds = new Set(credentials.map((credential) => credential.providerId));
  const catalogued: ProviderChoice[] = catalogue.providers.map((provider) => {
    const isOnPlan = plan !== undefined && provider.providerId === planProviderId;
    return {
      providerId: provider.providerId,
      name: isOnPlan ? `${provider.name} (your ChatGPT plan)` : provider.name,
      hasKey: isOnPlan ? plan.isConnected : keyedIds.has(provider.providerId),
      catalogued: provider,
      planModels: isOnPlan ? plan.models : undefined,
    };
  });
  const uncatalogued: ProviderChoice[] = credentials
    .filter(
      (credential) => !catalogued.some((choice) => choice.providerId === credential.providerId),
    )
    .map((credential) => ({
      providerId: credential.providerId,
      name: credential.providerId,
      hasKey: true,
      catalogued: undefined,
      planModels: undefined,
    }));
  const all = [...uncatalogued, ...catalogued];
  return [...all.filter((choice) => choice.hasKey), ...all.filter((choice) => !choice.hasKey)];
}

/** The models to list for a provider: its plan's, where it runs on one, otherwise the catalogue's. */
export function listChoosableModels(
  choice: ProviderChoice | undefined,
): Array<{ modelId: string; name: string }> {
  return choice?.planModels ?? choice?.catalogued?.models ?? [];
}

/** A model to start the choice on: the first listed model of the first provider the user can run. */
export function suggestModel(choices: readonly ProviderChoice[]): string | undefined {
  const keyed = choices.find((choice) => choice.hasKey);
  if (keyed === undefined) {
    return undefined;
  }
  const firstModel = listChoosableModels(keyed)[0];
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
  if (choice?.planModels !== undefined) {
    return "Your OpenAI models run on your ChatGPT plan, which is not connected. Connect it again in Settings, or switch OpenAI to your API key there.";
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
