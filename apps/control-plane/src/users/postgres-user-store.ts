import { escapeIdentifier, type Pool } from "pg";
import { databaseSchema } from "../thread-event-log/postgres-thread-event-log.js";
import type { UserStore } from "./user-store.js";

/**
 * Keeps users in Postgres, in the table created by
 * `migrations/0020_add_users_and_thread_owners.sql` (and the email digest
 * of 0100). Recording is one insert that, on conflict, only updates a digest
 * that changed, so concurrent first requests from a new user all succeed
 * and leave one row.
 */
export class PostgresUserStore implements UserStore {
  readonly #pool: Pool;
  readonly #table: string;

  constructor(pool: Pool, schema: string = databaseSchema) {
    this.#pool = pool;
    this.#table = `${escapeIdentifier(schema)}.users`;
  }

  async recordUser(userId: string, confirmedEmailDigest: Buffer | undefined): Promise<void> {
    await this.#pool.query(
      `insert into ${this.#table} (user_id, created_at, confirmed_email_digest)
        values ($1, now(), $2)
        on conflict (user_id) do update set confirmed_email_digest = excluded.confirmed_email_digest
          where ${this.#table}.confirmed_email_digest is distinct from excluded.confirmed_email_digest`,
      [userId, confirmedEmailDigest ?? null],
    );
  }

  async readConfirmedEmailDigest(userId: string): Promise<Buffer | undefined> {
    const result = await this.#pool.query<{ confirmed_email_digest: Buffer | null }>(
      `select confirmed_email_digest from ${this.#table} where user_id = $1`,
      [userId],
    );
    return result.rows[0]?.confirmed_email_digest ?? undefined;
  }

  async hasUser(userId: string): Promise<boolean> {
    const result = await this.#pool.query(`select 1 from ${this.#table} where user_id = $1`, [
      userId,
    ]);
    return result.rowCount === 1;
  }
}
