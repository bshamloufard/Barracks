import { findCatalogueProvider } from "@barrack/model-catalogue";
import {
  type CredentialSettings,
  credentialSecretSchema,
  credentialSettingsSchema,
  credentialSettingValueSchema,
  modelProviderIdSchema,
  parseModelReference,
} from "@barrack/protocol";
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
  readonly #clock: () => Date;
  readonly #logger: Logger;

  constructor(options: { store: ModelCredentialStore; clock?: () => Date; logger: Logger }) {
    this.#store = options.store;
    this.#clock = options.clock ?? (() => new Date());
    this.#logger = options.logger;
  }

  list(ownerUserId: string): Promise<ModelCredentialSummary[]> {
    return this.#store.list(ownerUserId);
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
   * thread alone; undefined if there is none or it cannot be opened, which
   * is logged without anything of the credential.
   */
  async read(ownerUserId: string, providerId: string): Promise<ModelCredential | undefined> {
    try {
      return await this.#store.read(ownerUserId, providerId);
    } catch (error) {
      if (!(error instanceof UnreadableCredentialError)) {
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
   * where, ending with what to do then. Undefined when they have the key.
   */
  async describeMissingCredential(
    ownerUserId: string,
    model: string,
    nextStep: string,
  ): Promise<string | undefined> {
    const { providerId } = parseModelReference(model);
    if (await this.#store.has(ownerUserId, providerId)) {
      return undefined;
    }
    return `${describeNeededKey(model)} Add it in Settings, under Model access, then ${nextStep}.`;
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
