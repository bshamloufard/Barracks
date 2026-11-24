import { escapeIdentifier, type Pool } from "pg";
import { databaseSchema } from "../thread-event-log/postgres-thread-event-log.js";
import {
  type AcceptedModelProxyToken,
  keptPerProvider,
  type ModelProxyTokenStore,
} from "./model-proxy-token-store.js";

/**
 * Model proxy tokens in Postgres, in the table created by
 * `migrations/0100_model_proxy_and_usage.sql`. Accepting a token and
 * retiring the oldest happen in one statement, so two instances accepting
 * at once leave at most a few more than the limit, never fewer.
 */
export class PostgresModelProxyTokenStore implements ModelProxyTokenStore {
  readonly #pool: Pool;
  readonly #table: string;

  constructor(pool: Pool, schema: string = databaseSchema) {
    this.#pool = pool;
    this.#table = `${escapeIdentifier(schema)}.model_proxy_tokens`;
  }

  /**
   * The delete runs on the snapshot taken before the insert, so it cannot
   * see the new token: it keeps one fewer of those already there.
   */
  async accept(token: AcceptedModelProxyToken): Promise<void> {
    await this.#pool.query(
      `with accepted as (
          insert into ${this.#table} (thread_id, provider_id, token_digest, minted_at)
            values ($1, $2, $3, $4)
            on conflict do nothing
        )
        delete from ${this.#table}
          where thread_id = $1 and provider_id = $2 and token_digest in (
            select token_digest from ${this.#table}
              where thread_id = $1 and provider_id = $2
              order by minted_at desc
              offset $5
          )`,
      [token.threadId, token.providerId, token.digest, token.mintedAt, keptPerProvider - 1],
    );
  }

  async listDigests(threadId: string, providerId: string): Promise<Buffer[]> {
    const result = await this.#pool.query<{ token_digest: Buffer }>(
      `select token_digest from ${this.#table} where thread_id = $1 and provider_id = $2`,
      [threadId, providerId],
    );
    return result.rows.map((row) => row.token_digest);
  }

  async revokeThread(threadId: string): Promise<void> {
    await this.#pool.query(`delete from ${this.#table} where thread_id = $1`, [threadId]);
  }
}
