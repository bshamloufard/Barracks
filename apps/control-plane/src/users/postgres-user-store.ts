import { escapeIdentifier, type Pool } from "pg";
import { databaseSchema } from "../thread-event-log/postgres-thread-event-log.js";
import type { UserStore } from "./user-store.js";

/**
 * Keeps users in Postgres, in the table created by
 * `migrations/0020_add_users_and_thread_owners.sql`. Recording is one insert
 * that does nothing on conflict, so concurrent first requests from a new user
 * all succeed and leave one row.
 */
export class PostgresUserStore implements UserStore {
  readonly #pool: Pool;
  readonly #table: string;

  constructor(pool: Pool, schema: string = databaseSchema) {
    this.#pool = pool;
    this.#table = `${escapeIdentifier(schema)}.users`;
  }

  async recordUser(userId: string): Promise<void> {
    await this.#pool.query(
      `insert into ${this.#table} (user_id, created_at) values ($1, now())
        on conflict (user_id) do nothing`,
      [userId],
    );
  }

  async hasUser(userId: string): Promise<boolean> {
    const result = await this.#pool.query(`select 1 from ${this.#table} where user_id = $1`, [
      userId,
    ]);
    return result.rowCount === 1;
  }
}
