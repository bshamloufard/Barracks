import type { CredentialKeyring } from "./credential-keyring.js";
import {
  type ModelCredential,
  type ModelCredentialStore,
  type ModelCredentialSummary,
  type NewModelCredential,
  openCredential,
  type SealedModelCredentialRow,
  sealCredential,
  summarise,
} from "./model-credential-store.js";

/**
 * Model credentials in memory, for development and tests, sealed exactly as
 * in Postgres so both are held to the same contract. Lost on restart.
 */
export class InMemoryModelCredentialStore implements ModelCredentialStore {
  readonly #keyring: CredentialKeyring;
  readonly #rows: Map<string, SealedModelCredentialRow>;

  /** `rows` lets a test share what is stored between stores with different keys. */
  constructor(keyring: CredentialKeyring, rows = new Map<string, SealedModelCredentialRow>()) {
    this.#keyring = keyring;
    this.#rows = rows;
  }

  async save(credential: NewModelCredential): Promise<ModelCredentialSummary> {
    const row = sealCredential(this.#keyring, credential);
    this.#rows.set(rowKey(credential.ownerUserId, credential.providerId), row);
    return summarise(row);
  }

  async remove(ownerUserId: string, providerId: string): Promise<boolean> {
    return this.#rows.delete(rowKey(ownerUserId, providerId));
  }

  async list(ownerUserId: string): Promise<ModelCredentialSummary[]> {
    return [...this.#rows.values()]
      .filter((row) => row.ownerUserId === ownerUserId)
      .map(summarise)
      .sort((first, second) => first.providerId.localeCompare(second.providerId));
  }

  async has(ownerUserId: string, providerId: string): Promise<boolean> {
    return this.#rows.has(rowKey(ownerUserId, providerId));
  }

  async read(ownerUserId: string, providerId: string): Promise<ModelCredential | undefined> {
    const row = this.#rows.get(rowKey(ownerUserId, providerId));
    return row === undefined ? undefined : openCredential(this.#keyring, row);
  }

  async countByKeyFingerprint(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const { sealed } of this.#rows.values()) {
      counts.set(sealed.keyFingerprint, (counts.get(sealed.keyFingerprint) ?? 0) + 1);
    }
    return counts;
  }

  async sealAgainUnderCurrentKey(): Promise<number> {
    let resealedCount = 0;
    for (const [key, row] of this.#rows) {
      if (row.sealed.keyFingerprint === this.#keyring.currentFingerprint) {
        continue;
      }
      const opened = openCredential(this.#keyring, row);
      this.#rows.set(key, sealCredential(this.#keyring, { ...row, ...opened }));
      resealedCount += 1;
    }
    return resealedCount;
  }
}

function rowKey(ownerUserId: string, providerId: string): string {
  return `${ownerUserId}\0${providerId}`;
}
