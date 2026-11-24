import { z } from "zod";

/**
 * Which model a thread's agent runs on, and the user's own credential for
 * that model's provider. Barrack never pays for model use: each user adds
 * their own key for each provider, and a thread's agent only ever receives
 * its owner's key for its own model's provider.
 *
 * Names here are the agent's, not any one harness's: a provider is whoever
 * serves the model (such as `anthropic` or `openrouter`), and a model
 * reference is `provider/model`, the form the agent is told and users see.
 */

/** A model provider's identifier, as the agent's catalogue names it, such as `anthropic`. */
export const modelProviderIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    "must be a provider identifier: lower-case letters, digits, '.', '_' or '-', at most 64",
  );

/** Model identifiers are the provider's own; some contain `/`, `@`, `:` or `~`. */
export const maximumModelIdLength = 256;

/**
 * `provider/model`: the provider up to the first `/`, the model after it,
 * which may itself contain `/` (OpenRouter's `anthropic/…`, say).
 */
export const modelReferenceSchema = z
  .string()
  .max(64 + 1 + maximumModelIdLength)
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}\/[^\s/][^\s]*$/,
    'must be "provider/model", such as "anthropic/<model id>", with no spaces',
  );

export type ModelReference = z.infer<typeof modelReferenceSchema>;

export type ParsedModelReference = { providerId: string; modelId: string };

/** Splits a valid model reference at its first `/`. */
export function parseModelReference(reference: ModelReference): ParsedModelReference {
  const separatorIndex = reference.indexOf("/");
  return {
    providerId: reference.slice(0, separatorIndex),
    modelId: reference.slice(separatorIndex + 1),
  };
}

/**
 * How the model provider ended a request, when it failed for a reason the
 * user can act on. The harness classifies its agent's own error reports into
 * these, so no client reads meaning into a provider's wording:
 * - `credential_missing`: there is no key for the model's provider (the
 *   user removed it, say). Add one in Settings.
 * - `credential_rejected`: the provider refused the key. Replace it in
 *   Settings.
 * - `quota_exhausted`: the account behind the key is out of credit, quota or
 *   plan allowance. Add credit with the provider, or switch the thread to
 *   another model.
 * - `rate_limited`: too many requests for now, after the agent's own retries
 *   ran out. Wait, then send again.
 */
export const modelAccessErrorKindSchema = z.enum([
  "credential_missing",
  "credential_rejected",
  "quota_exhausted",
  "rate_limited",
]);

export type ModelAccessErrorKind = z.infer<typeof modelAccessErrorKindSchema>;

/**
 * A credential's secret: an API key or token. Keys are printable ASCII
 * without spaces; 8 Ki characters leaves room for the longest bearer
 * tokens providers issue. No key contains a quotation mark or a backslash,
 * and refusing them means a key reads the same inside JSON as outside it,
 * which is what lets the supervisor find and redact one in a log line.
 */
export const maximumCredentialSecretLength = 8 * 1024;

export const credentialSecretSchema = z
  .string()
  .min(8, "is too short to be a key")
  .max(maximumCredentialSecretLength)
  .regex(
    /^[\x21\x23-\x5b\x5d-\x7e]+$/,
    "must be printable characters without spaces, quotation marks, backslashes or line breaks",
  );

/**
 * The settings some providers need beside a key, such as Cloudflare's
 * account identifier or an Azure endpoint, named as the agent's catalogue
 * names them (`CLOUDFLARE_ACCOUNT_ID`). Not secret, but stored and sent with
 * the key.
 */
export const credentialSettingNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

export const credentialSettingValueSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\n\r\0]+$/, "must be one line");

export const credentialSettingsSchema = z
  .record(credentialSettingNameSchema, credentialSettingValueSchema)
  .refine((settings) => Object.keys(settings).length <= 8, "at most 8 settings");

export type CredentialSettings = z.infer<typeof credentialSettingsSchema>;

/**
 * Sent by the control plane right after `prepare_workspace`, and again
 * whenever what it says changes (the user replaced or removed the key, or
 * chose another model): the thread's model, and its owner's credential for
 * that model's provider, or null when there is none. The control plane
 * decides both from the thread and its owner, never from anything a
 * supervisor sends; nothing a supervisor can send asks for a credential.
 *
 * The credential is the user's secret. A supervisor hands it to its agent,
 * and never writes it to its log, its environment or an event (see the
 * supervisor's README for where it goes). A model change takes effect for
 * the agent's next run; a replaced or removed key, at once.
 *
 * Only API keys exist today. A credential that expires and is refreshed by
 * the control plane (a subscription's access token) would be another
 * `kind`, sent again before each expiry in the same way.
 */
export const configureModelAccessSchema = z.strictObject({
  type: z.literal("configure_model_access"),
  /** Null for a thread created without one, which an agent that needs a model cannot run. */
  model: modelReferenceSchema.nullable(),
  credential: z
    .strictObject({
      kind: z.literal("api_key"),
      secret: credentialSecretSchema,
      settings: credentialSettingsSchema,
    })
    .nullable(),
});

export type ConfigureModelAccess = z.infer<typeof configureModelAccessSchema>;
export type ModelCredential = NonNullable<ConfigureModelAccess["credential"]>;

// --- The HTTP API for model access -----------------------------------------
//
// - `GET /api/model-catalogue`: the providers and models the agent supports,
//   from the catalogue generated from it (`ModelCatalogue`).
// - `GET /api/model-credentials`: which providers the user has a key for,
//   never the keys themselves (`ModelCredentialListResponse`).
// - `PUT /api/model-credentials/{providerId}` with `{ secret, settings }`:
//   adds the key, or replaces the one there (200); 400 for one that cannot
//   be a key, or settings the provider does not take.
// - `DELETE /api/model-credentials/{providerId}`: removes it (200 with the
//   remaining list); threads using it stop being able to run until a key
//   is added again.
// - `PUT /api/threads/{threadId}/model` with `{ model }`: switches the
//   thread's model, for its next run (200 with the thread); 409
//   `model_credential_missing` without a key for its provider.

export const modelCatalogueApiPath = "/api/model-catalogue";
export const modelCredentialsApiPath = "/api/model-credentials";

export function buildModelCredentialApiPath(providerId: string): string {
  return `${modelCredentialsApiPath}/${encodeURIComponent(providerId)}`;
}

/** A model the agent's catalogue lists. */
export const catalogueModelSchema = z.strictObject({
  modelId: z.string().min(1).max(maximumModelIdLength),
  name: z.string().min(1),
  contextWindow: z.int().nonnegative(),
  reasoning: z.boolean(),
});

/** A setting a provider needs beside its key. */
export const catalogueCredentialSettingSchema = z.strictObject({
  name: credentialSettingNameSchema,
  label: z.string().min(1),
});

/** A provider the agent can use with an API key, and the models it lists for it. */
export const catalogueProviderSchema = z.strictObject({
  providerId: modelProviderIdSchema,
  name: z.string().min(1),
  /** What the key is called, such as "Anthropic API key". */
  secretLabel: z.string().min(1),
  settings: z.array(catalogueCredentialSettingSchema),
  /** Among the providers most people use, which clients list first. */
  isCommon: z.boolean(),
  models: z.array(catalogueModelSchema),
});

/**
 * What the agent Barrack runs supports, generated from its pinned version
 * (`agent`). It is a snapshot: the agent may know models added after it was
 * generated, and the user may enter any model identifier, listed or not.
 */
export const modelCatalogueSchema = z.strictObject({
  agent: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  providers: z.array(catalogueProviderSchema),
});

export type CatalogueModel = z.infer<typeof catalogueModelSchema>;
export type CatalogueCredentialSetting = z.infer<typeof catalogueCredentialSettingSchema>;
export type CatalogueProvider = z.infer<typeof catalogueProviderSchema>;
export type ModelCatalogue = z.infer<typeof modelCatalogueSchema>;

/** Adds a key, or replaces the user's key for the provider. */
export const saveModelCredentialRequestSchema = z.strictObject({
  secret: z.string().max(maximumCredentialSecretLength + 1024),
  settings: z.record(z.string(), z.string()).default({}),
});

/**
 * What a client may know of a stored key: that it exists, when it was
 * added, and its last four characters, enough to tell two keys apart and
 * far too little to use.
 */
export const modelCredentialSummarySchema = z.strictObject({
  providerId: modelProviderIdSchema,
  addedAt: z.iso.datetime(),
  secretEnding: z.string().max(4),
});

export const modelCredentialListResponseSchema = z.strictObject({
  credentials: z.array(modelCredentialSummarySchema),
});

export const modelCredentialResponseSchema = z.strictObject({
  credential: modelCredentialSummarySchema,
});

export const changeThreadModelRequestSchema = z.strictObject({ model: modelReferenceSchema });

export type SaveModelCredentialRequest = z.infer<typeof saveModelCredentialRequestSchema>;
export type ModelCredentialSummary = z.infer<typeof modelCredentialSummarySchema>;
export type ModelCredentialListResponse = z.infer<typeof modelCredentialListResponseSchema>;
export type ModelCredentialResponse = z.infer<typeof modelCredentialResponseSchema>;
export type ChangeThreadModelRequest = z.infer<typeof changeThreadModelRequestSchema>;
