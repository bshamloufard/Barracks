import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CatalogueCredentialSetting,
  GeneratedCatalogueProvider,
  GeneratedModelCatalogue,
} from "@barrack/protocol";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Reads, from the pinned Pi itself, every provider Pi can use with an API
 * key and every chat model it lists for each. Nothing here is copied from
 * Pi's documentation: the providers, their models, and what each asks for
 * when a key is added all come from Pi's own model runtime, so a new Pi
 * version is followed by running the generator again.
 *
 * What a provider asks for comes from its own key login, run here with a
 * stand-in for the person answering: the secret it prompts for, and the
 * settings it stores beside the key (Cloudflare's account, say), named as
 * Pi reads them. A provider offering several ways to sign in is offered
 * only its key or token; one with no key login (a subscription only) is
 * left out.
 */

/** The providers most people bring a key for, listed first in this order. */
const commonProviderIds = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "mistral",
  "xai",
  "deepseek",
  "groq",
];

/** When a provider asks how to sign in, the answers that mean "with a key". */
const keyLoginOptionIds = new Set(["api-key", "bearer-token"]);

/**
 * Settings a provider needs that its key login does not ask for. Azure's
 * login asks only for the key, while requests need the resource's endpoint,
 * which Pi reads from the credential's settings as from the environment
 * (`AZURE_OPENAI_BASE_URL` in pi-ai's `api/azure-openai-config.js`).
 */
const settingsLoginsLeaveOut: Readonly<Record<string, CatalogueCredentialSetting[]>> = {
  azure: [
    {
      name: "AZURE_OPENAI_BASE_URL",
      label: "Azure OpenAI endpoint, such as https://<resource>.openai.azure.com",
    },
  ],
};

type RuntimeProvider = ReturnType<ModelRuntime["getProviders"]>[number];
type KeyLogin = NonNullable<NonNullable<RuntimeProvider["auth"]["apiKey"]>["login"]>;
type LoginInteraction = Parameters<KeyLogin>[0];
type LoginPrompt = Parameters<LoginInteraction["prompt"]>[0];

export async function readAgentCatalogue(): Promise<GeneratedModelCatalogue> {
  const scratchDirectory = await mkdtemp(path.join(tmpdir(), "barrack-model-catalogue-"));
  try {
    // A runtime of its own, with empty credentials and no network, so the
    // catalogue is the one bundled with this version of Pi and nothing of
    // the machine it is generated on.
    const runtime = await ModelRuntime.create({
      authPath: path.join(scratchDirectory, "auth.json"),
      modelsPath: null,
      modelsStorePath: path.join(scratchDirectory, "models-store.json"),
      refreshOnCreate: false,
    });
    const providers: GeneratedCatalogueProvider[] = [];
    for (const provider of runtime.getProviders()) {
      const catalogued = await describeProvider(runtime, provider);
      if (catalogued !== undefined) {
        providers.push(catalogued);
      }
    }
    return {
      agent: { name: "Pi", version: await readPinnedAgentVersion() },
      providers: providers.sort(compareProviders),
    };
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

/** The version of Pi installed here, which the test checks is the supervisor's pinned one. */
export async function readPinnedAgentVersion(): Promise<string> {
  const entryPoint = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const packageFile = path.join(path.dirname(entryPoint), "..", "package.json");
  const { version } = JSON.parse(await readFile(packageFile, "utf8")) as { version: string };
  return version;
}

async function describeProvider(
  runtime: ModelRuntime,
  provider: RuntimeProvider,
): Promise<GeneratedCatalogueProvider | undefined> {
  const keyLogin = await readKeyLogin(provider);
  if (keyLogin === undefined) {
    return undefined;
  }
  return {
    providerId: provider.id,
    name: provider.name,
    secretLabel: keyLogin.secretLabel,
    settings: [...keyLogin.settings, ...(settingsLoginsLeaveOut[provider.id] ?? [])],
    isCommon: commonProviderIds.includes(provider.id),
    models: runtime.getModels(provider.id).map((model) => ({
      modelId: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
    })),
  };
}

/**
 * Runs the provider's key login with made-up answers and reads back what it
 * asked for. Each text answer is unique, so the setting it ended up in can
 * be found in the credential the login returns.
 */
async function readKeyLogin(
  provider: RuntimeProvider,
): Promise<{ secretLabel: string; settings: CatalogueCredentialSetting[] } | undefined> {
  const login = provider.auth.apiKey?.login;
  if (login === undefined) {
    return undefined;
  }
  const prompts: LoginPrompt[] = [];
  let choseKeyLogin = true;
  const answerFor = (prompt: LoginPrompt): string => {
    prompts.push(prompt);
    if (prompt.type !== "select") {
      return `answer-${prompts.length}`;
    }
    const keyOption = prompt.options.find((option) => keyLoginOptionIds.has(option.id));
    choseKeyLogin &&= keyOption !== undefined;
    return keyOption?.id ?? "";
  };
  const interaction: LoginInteraction = {
    signal: new AbortController().signal,
    prompt: async (prompt) => answerFor(prompt),
    notify: () => {},
  };
  // A login that fails with these answers (one wanting a choice it was not
  // offered, say) is one Barrack cannot offer.
  const credential = await login(interaction).catch(() => undefined);
  const secretPrompt = prompts.find((prompt) => prompt.type === "secret");
  if (!choseKeyLogin || credential === undefined || secretPrompt === undefined) {
    return undefined;
  }
  return {
    secretLabel: describePrompt(secretPrompt),
    settings: readSettings(prompts, credential.env ?? {}),
  };
}

function readSettings(
  prompts: LoginPrompt[],
  storedSettings: Record<string, string>,
): CatalogueCredentialSetting[] {
  return Object.entries(storedSettings).flatMap(([name, answer]) => {
    const promptIndex = Number(answer.replace("answer-", "")) - 1;
    const prompt = prompts[promptIndex];
    return prompt === undefined ? [] : [{ name, label: describePrompt(prompt) }];
  });
}

/** "Enter Cloudflare account ID" becomes "Cloudflare account ID". */
function describePrompt(prompt: LoginPrompt): string {
  return prompt.message.replace(/^Enter\s+/, "");
}

function compareProviders(
  first: GeneratedCatalogueProvider,
  second: GeneratedCatalogueProvider,
): number {
  const firstRank = rankOf(first.providerId);
  const secondRank = rankOf(second.providerId);
  if (firstRank !== secondRank) {
    return firstRank - secondRank;
  }
  return first.name.localeCompare(second.name, "en");
}

function rankOf(providerId: string): number {
  const index = commonProviderIds.indexOf(providerId);
  return index === -1 ? commonProviderIds.length : index;
}
