import { z } from "zod";
import type {
  CredentialBinding,
  CredentialKeyring,
  SealedCredential,
} from "../model-access/credential-keyring.js";
import type { AttemptSecrets, PlanTokens } from "./chatgpt-plan-store.js";

/**
 * A ChatGPT plan's tokens, and a sign-in attempt's PKCE verifier and nonce,
 * are sealed under the same configured key as users' model keys, bound to
 * their owner and to what they are. A provider's identifier never holds a
 * `/`, so neither binding can be a model key's: a sealed value copied from
 * one table to another, or from one user's row to another's, does not open.
 */
function signInBinding(ownerUserId: string): CredentialBinding {
  return { ownerUserId, providerId: "openai/chatgpt-plan-sign-in" };
}

function attemptBinding(ownerUserId: string): CredentialBinding {
  return { ownerUserId, providerId: "openai/chatgpt-sign-in-attempt" };
}

const planTokensSchema = z.strictObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

const attemptSecretsSchema = z.strictObject({
  codeVerifier: z.string().min(43),
  nonce: z.string().min(1),
});

export function sealPlanTokens(
  keyring: CredentialKeyring,
  ownerUserId: string,
  tokens: PlanTokens,
): SealedCredential {
  return keyring.seal(JSON.stringify(tokens), signInBinding(ownerUserId));
}

/** Throws `UnreadableCredentialError` for tokens sealed under an unknown key, altered, or moved. */
export function openPlanTokens(
  keyring: CredentialKeyring,
  ownerUserId: string,
  sealed: SealedCredential,
): PlanTokens {
  return planTokensSchema.parse(JSON.parse(keyring.open(sealed, signInBinding(ownerUserId))));
}

export function sealAttemptSecrets(
  keyring: CredentialKeyring,
  ownerUserId: string,
  secrets: AttemptSecrets,
): SealedCredential {
  return keyring.seal(JSON.stringify(secrets), attemptBinding(ownerUserId));
}

export function openAttemptSecrets(
  keyring: CredentialKeyring,
  ownerUserId: string,
  sealed: SealedCredential,
): AttemptSecrets {
  return attemptSecretsSchema.parse(JSON.parse(keyring.open(sealed, attemptBinding(ownerUserId))));
}
