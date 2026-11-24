import { escapeIdentifier, type Pool } from "pg";
import { databaseSchema } from "../thread-event-log/postgres-thread-event-log.js";
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

type CredentialRow = {
  user_id: string;
  provider_id: string;
  key_fingerprint: string;
  nonce: Buffer;
  ciphertext: Buffer;
  secret_ending: string;
  added_at: Date;
};

const credentialColumns =
  "user_id, provider_id, key_fingerprint, nonce, ciphertext, secret_ending, added_at";

/**
 * Keeps model credentials in Postgres, in the table created by
 * `migrations/0080_model_access.sql`, sealed before they are written and
 * opened only by `read` (see `CredentialKeyring`). Saving is one upsert, so
 * a key replaced from two tabs at once leaves one of the two, whole.
 */
export class PostgresModelCredentialStore implements ModelCredentialStore {
  readonly #pool: Pool;
  readonly #keyring: CredentialKeyring;
  readonly #table: string;

  constructor(pool: Pool, keyring: CredentialKeyring, schema: string = databaseSchema) {
    this.#pool = pool;
    this.#keyring = keyring;
    this.#table = `${escapeIdentifier(schema)}.model_credentials`;
  }

  async save(credential: NewModelCredential): Promise<ModelCredentialSummary> {
    const row = sealCredential(this.#keyring, credential);
    await this.#pool.query(
      `insert into ${this.#table} (${credentialColumns})
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (user_id, provider_id) do update set
          key_fingerprint = excluded.key_fingerprint,
          nonce = excluded.nonce,
          ciphertext = excluded.ciphertext,
          secret_ending = excluded.secret_ending,
          added_at = excluded.added_at`,
      [
        row.ownerUserId,
        row.providerId,
        row.sealed.keyFingerprint,
        row.sealed.nonce,
        row.sealed.ciphertext,
        row.secretEnding,
        row.addedAt,
      ],
    );
    return summarise(row);
  }

  async remove(ownerUserId: string, providerId: string): Promise<boolean> {
    const result = await this.#pool.query(
      `delete from ${this.#table} where user_id = $1 and provider_id = $2`,
      [ownerUserId, providerId],
    );
    return result.rowCount === 1;
  }

  async list(ownerUserId: string): Promise<ModelCredentialSummary[]> {
    const result = await this.#pool.query<
      Pick<CredentialRow, "provider_id" | "secret_ending" | "added_at">
    >(
      `select provider_id, secret_ending, added_at from ${this.#table}
        where user_id = $1 order by provider_id`,
      [ownerUserId],
    );
    return result.rows.map((row) => ({
      providerId: row.provider_id,
      addedAt: row.added_at,
      secretEnding: row.secret_ending,
    }));
  }

  async has(ownerUserId: string, providerId: string): Promise<boolean> {
    const result = await this.#pool.query(
      `select 1 from ${this.#table} where user_id = $1 and provider_id = $2`,
      [ownerUserId, providerId],
    );
    return result.rowCount === 1;
  }

  async read(ownerUserId: string, providerId: string): Promise<ModelCredential | undefined> {
    const result = await this.#pool.query<CredentialRow>(
      `select ${credentialColumns} from ${this.#table} where user_id = $1 and provider_id = $2`,
      [ownerUserId, providerId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : openCredential(this.#keyring, toSealedRow(row));
  }

  async countByKeyFingerprint(): Promise<Map<string, number>> {
    const result = await this.#pool.query<{ key_fingerprint: string; count: string }>(
      `select key_fingerprint, count(*) as count from ${this.#table} group by key_fingerprint`,
    );
    return new Map(result.rows.map((row) => [row.key_fingerprint, Number(row.count)]));
  }

  /**
   * Each one is replaced only if it is still as read, so a key the user
   * replaced meanwhile is not overwritten with the old one.
   */
  async sealAgainUnderCurrentKey(): Promise<number> {
    const result = await this.#pool.query<CredentialRow>(
      `select ${credentialColumns} from ${this.#table} where key_fingerprint <> $1`,
      [this.#keyring.currentFingerprint],
    );
    let resealedCount = 0;
    for (const row of result.rows) {
      const sealedRow = toSealedRow(row);
      const resealed = sealCredential(this.#keyring, {
        ...sealedRow,
        ...openCredential(this.#keyring, sealedRow),
      });
      const update = await this.#pool.query(
        `update ${this.#table} set key_fingerprint = $3, nonce = $4, ciphertext = $5
          where user_id = $1 and provider_id = $2 and nonce = $6`,
        [
          row.user_id,
          row.provider_id,
          resealed.sealed.keyFingerprint,
          resealed.sealed.nonce,
          resealed.sealed.ciphertext,
          row.nonce,
        ],
      );
      resealedCount += update.rowCount ?? 0;
    }
    return resealedCount;
  }
}

function toSealedRow(row: CredentialRow): SealedModelCredentialRow {
  return {
    ownerUserId: row.user_id,
    providerId: row.provider_id,
    addedAt: row.added_at,
    secretEnding: row.secret_ending,
    sealed: { keyFingerprint: row.key_fingerprint, nonce: row.nonce, ciphertext: row.ciphertext },
  };
}
