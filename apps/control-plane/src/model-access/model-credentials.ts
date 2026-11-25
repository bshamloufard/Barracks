import { findCatalogueProvider } from "@barrack/model-catalogue";
import {
  type CredentialSettings,
  credentialSecretSchema,
  credentialSettingsSchema,
  credentialSettingValueSchema,
  modelProviderIdSchema,
  parseModelReference,
} from "@barrack/protocol";
import type { ChatGptPlanAccess } from "../chatgpt-plan/chatgpt-plan-access.js";
import type { Logger } from "../logger.js";
import { UnreadableCredentialError } from "./credential-keyring.js";
import type {
  ModelCredential,
  ModelCredentialStore,
  ModelCredentialSummary,
} from "./model-credential-store.js";

export type SaveCredentialOutcome =
  | { kind: "saved"; credential: ModelCredentialSummary }
  | { kind: "invalid"; message: string };

/**
 * What a user may do with their model credentials, and what the rest of the
 * control plane may know of them. A key is checked for plausibility only:
 * that it could be a key, and that the settings are the ones its provider
 * needs. Nothing calls the provider to try it; the first run says plainly if
 * the provider refuses it (see the decision log).
 */
export class ModelCredentials {
  readonly #store: ModelCredentialStore;
  readonly #chatGptPlan: ChatGptPlanAccess;
  readonly #clock: () => Date;
  readonly #logger: Logger;

  /** `chatGptPlan` says when a user's OpenAI models run on their plan rather than a key. */
  constructor(options: {
    store: ModelCredentialStore;
    chatGptPlan: ChatGptPlanAccess;
    clock?: () => Date;
    logger: Logger;
  }) {
    this.#store = options.store;
    this.#chatGptPlan = options.chatGptPlan;
    this.#clock = options.clock ?? (() => new Date());
    this.#logger = options.logger;
  }

  list(ownerUserId: string): Promise<ModelCredentialSummary[]> {
    return this.#store.list(ownerUserId);
  }

  /** Whether the owner has a key for the provider, without opening it. */
  has(ownerUserId: string, providerId: string): Promise<boolean> {
    return this.#store.has(ownerUserId, providerId);
  }

  async save(
    ownerUserId: string,
    providerId: string,
    request: { secret: string; settings: Record<string, string> },
  ): Promise<SaveCredentialOutcome> {
    const checked = checkCredential(providerId, request);
    if (checked.kind === "invalid") {
      return checked;
    }
    const credential = await this.#store.save({
      ownerUserId,
      providerId,
      ...checked.credential,
      addedAt: this.#clock(),
    });
    this.#logger.info({ ownerUserId, providerId }, "Saved a user's model credential");
    return { kind: "saved", credential };
  }

  async remove(ownerUserId: string, providerId: string): Promise<boolean> {
    const wasRemoved = await this.#store.remove(ownerUserId, providerId);
    if (wasRemoved) {
      this.#logger.info({ ownerUserId, providerId }, "Removed a user's model credential");
    }
    return wasRemoved;
  }

  /**
   * The owner's credential for the provider, opened, for that owner's own
   * thread alone; undefined if there is none, or if it was altered, which is
   * logged without anything of the credential.
   *
   * One sealed under a key this control plane does not hold throws
   * `UnreadableCredentialError` (`unknown_key`) instead: during a key
   * rotation's overlap the instance being replaced cannot open what the new
   * one sealed again, and must leave a sandbox the key it already has
   * rather than withdraw it as if the user had removed it.
   */
  async read(ownerUserId: string, providerId: string): Promise<ModelCredential | undefined> {
    try {
      return await this.#store.read(ownerUserId, providerId);
    } catch (error) {
      if (!(error instanceof UnreadableCredentialError)) {
        throw error;
      }
      if (error.reason === "unknown_key") {
        this.#logger.warn(
          { ownerUserId, providerId },
          "A user's model credential is sealed under a key this control plane does not hold (another instance rotated it); leaving sandboxes the key they have",
        );
        throw error;
      }
      this.#logger.error(
        { ownerUserId, providerId, reason: error.reason },
        "A user's model credential could not be opened; treating it as missing",
      );
      return undefined;
    }
  }

  /**
   * Why the owner cannot run `model`, for the user: which key to add and
   * where, or, for an OpenAI model they chose to run on their ChatGPT plan,
   * that the plan is not connected; ending with what to do then. Undefined
   * when they can.
   */
  async describeMissingCredential(
    ownerUserId: string,
    model: string,
    nextStep: string,
  ): Promise<string | undefined> {
    const { providerId } = parseModelReference(model);
    if ((await this.#chatGptPlan.findAccess(ownerUserId, providerId)) === "chatgpt_plan") {
      return (await this.#chatGptPlan.isConnected(ownerUserId))
        ? undefined
        : this.#describeUnusablePlan(model, nextStep);
    }
    if (await this.#store.has(ownerUserId, providerId)) {
      return undefined;
    }
    return `${describeNeededKey(model)} Add it in Settings, under Model access, then ${nextStep}.`;
  }

  #describeUnusablePlan(model: string, nextStep: string): string {
    return this.#chatGptPlan.isOffered
      ? `${model} runs on your ChatGPT plan, which is not connected now. Connect it again in Settings, under ChatGPT plan, or switch OpenAI to your API key there, then ${nextStep}.`
      : `${model} runs on your ChatGPT plan, which this installation no longer offers. Switch OpenAI to your API key in Settings, under ChatGPT plan, then ${nextStep}.`;
  }
}

/** "anthropic/model-x runs on Anthropic, and you have no Anthropic API key." */
export function describeNeededKey(model: string): string {
  const { providerId } = parseModelReference(model);
  const provider = findCatalogueProvider(providerId);
  if (provider === undefined) {
    return `${model} needs a key for the provider "${providerId}", and you have none.`;
  }
  return `${model} runs on ${provider.name}, and you have no ${provider.secretLabel}.`;
}

type CheckedCredential =
  | { kind: "valid"; credential: ModelCredential }
  | { kind: "invalid"; message: string };

function checkCredential(
  providerId: string,
  request: { secret: string; settings: Record<string, string> },
): CheckedCredential {
  if (!modelProviderIdSchema.safeParse(providerId).success) {
    return { kind: "invalid", message: `"${providerId}" cannot be a model provider's name.` };
  }
  const secret = request.secret.trim();
  const secretCheck = credentialSecretSchema.safeParse(secret);
  if (!secretCheck.success) {
    const reason = secretCheck.error.issues[0]?.message ?? "is not a key";
    return { kind: "invalid", message: `That cannot be a key: it ${reason}.` };
  }
  const settings = checkSettings(providerId, request.settings);
  if (settings.kind === "invalid") {
    return settings;
  }
  return { kind: "valid", credential: { secret, settings: settings.settings } };
}

/**
 * A catalogued provider takes exactly the settings its catalogue entry
 * names, each required; a provider the catalogue does not list (one the
 * user configured for the agent themselves) may have any.
 */
function checkSettings(
  providerId: string,
  requested: Record<string, string>,
): { kind: "valid"; settings: CredentialSettings } | { kind: "invalid"; message: string } {
  const trimmed = Object.fromEntries(
    Object.entries(requested).map(([name, value]) => [name, value.trim()]),
  );
  const provider = findCatalogueProvider(providerId);
  if (provider === undefined) {
    const checked = credentialSettingsSchema.safeParse(trimmed);
    return checked.success
      ? { kind: "valid", settings: checked.data }
      : { kind: "invalid", message: "Settings are named in capitals, each holding one line." };
  }
  const neededNames = provider.settings.map((setting) => setting.name);
  const unexpectedName = Object.keys(trimmed).find((name) => !neededNames.includes(name));
  if (unexpectedName !== undefined) {
    return { kind: "invalid", message: `${provider.name} takes no setting "${unexpectedName}".` };
  }
  const missing = provider.settings.find(
    (setting) => !credentialSettingValueSchema.safeParse(trimmed[setting.name]).success,
  );
  if (missing !== undefined) {
    return {
      kind: "invalid",
      message: `${provider.name} needs its ${missing.label}, on one line.`,
    };
  }
  return { kind: "valid", settings: trimmed };
}
