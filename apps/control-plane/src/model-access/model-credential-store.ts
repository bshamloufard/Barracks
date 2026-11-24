import type { CredentialSettings } from "@barrack/protocol";
import {
  type CredentialKeyring,
  type SealedCredential,
  UnreadableCredentialError,
} from "./credential-keyring.js";

/**
 * Each user's model credentials, one per provider: an API key and any
 * settings the provider needs beside it. Stored sealed under the
 * configuration's key (`CredentialKeyring`) and bound to their owner and
 * provider; only `read` ever opens one, and only for the control plane to
 * hand to that owner's own thread. Nothing here is logged.
 */
export interface ModelCredentialStore {
  /** Adds the owner's credential for the provider, or replaces the one there. */
  save(credential: NewModelCredential): Promise<ModelCredentialSummary>;

  /** Returns whether there was one to remove. */
  remove(ownerUserId: string, providerId: string): Promise<boolean>;

  /** What may be shown of the owner's credentials, without opening any. */
  list(ownerUserId: string): Promise<ModelCredentialSummary[]>;

  has(ownerUserId: string, providerId: string): Promise<boolean>;

  /**
   * The credential, opened, or undefined if there is none. Throws
   * `UnreadableCredentialError` for one sealed under a key the store was
   * not given, or altered, or moved from another row.
   */
  read(ownerUserId: string, providerId: string): Promise<ModelCredential | undefined>;

  /** How many credentials each key has sealed, by fingerprint, to check at startup. */
  countByKeyFingerprint(): Promise<Map<string, number>>;

  /**
   * Seals again, under the current key, every credential a previous key
   * sealed, so that key can then be retired. One it cannot open (sealed
   * under a key it was not given, or altered) is left as it is and counted,
   * and the rest are still resealed.
   */
  sealAgainUnderCurrentKey(): Promise<ResealingOutcome>;
}

export type ResealingOutcome = { resealedCount: number; unreadableCount: number };

export type ModelCredential = {
  secret: string;
  settings: CredentialSettings;
};

export type NewModelCredential = ModelCredential & {
  ownerUserId: string;
  providerId: string;
  addedAt: Date;
};

export type ModelCredentialSummary = {
  providerId: string;
  addedAt: Date;
  /** The secret's last four characters, to tell two keys apart. */
  secretEnding: string;
};

/** A credential as both stores keep it: sealed, with what may be shown beside it. */
export type SealedModelCredentialRow = ModelCredentialSummary & {
  ownerUserId: string;
  sealed: SealedCredential;
};

/** Four characters of a key of at least eight say almost nothing of it. */
export function describeSecretEnding(secret: string): string {
  return secret.slice(-4);
}

/** Seals a new credential's secret and settings together, as one value bound to its row. */
export function sealCredential(
  keyring: CredentialKeyring,
  credential: NewModelCredential,
): SealedModelCredentialRow {
  const plaintext = JSON.stringify({ secret: credential.secret, settings: credential.settings });
  return {
    ownerUserId: credential.ownerUserId,
    providerId: credential.providerId,
    addedAt: credential.addedAt,
    secretEnding: describeSecretEnding(credential.secret),
    sealed: keyring.seal(plaintext, credential),
  };
}

/** The credential sealed again under the keyring's current key, or undefined if it cannot be opened. */
export function sealAgain(
  keyring: CredentialKeyring,
  row: SealedModelCredentialRow,
): SealedModelCredentialRow | undefined {
  let opened: ModelCredential;
  try {
    opened = openCredential(keyring, row);
  } catch (error) {
    if (error instanceof UnreadableCredentialError) {
      return undefined;
    }
    throw error;
  }
  return sealCredential(keyring, { ...row, ...opened });
}

export function openCredential(
  keyring: CredentialKeyring,
  row: SealedModelCredentialRow,
): ModelCredential {
  const { secret, settings } = JSON.parse(keyring.open(row.sealed, row)) as ModelCredential;
  return { secret, settings };
}

export function summarise(row: SealedModelCredentialRow): ModelCredentialSummary {
  return { providerId: row.providerId, addedAt: row.addedAt, secretEnding: row.secretEnding };
}
