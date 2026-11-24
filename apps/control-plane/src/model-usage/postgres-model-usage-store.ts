import type { ModelUsageSource, ModelUsageTotals } from "@barrack/protocol";
import { escapeIdentifier, type Pool } from "pg";
import { databaseSchema } from "../thread-event-log/postgres-thread-event-log.js";
import { type AnswerUsage, hourOf, type ModelUsageStore } from "./model-usage-store.js";

type TotalsRow = {
  provider_id: string;
  model_id: string;
  source: ModelUsageSource;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  answer_count: string;
};

const summedColumns = `provider_id, model_id, source,
  sum(input_tokens)::text as input_tokens,
  sum(output_tokens)::text as output_tokens,
  sum(cache_read_tokens)::text as cache_read_tokens,
  sum(cache_write_tokens)::text as cache_write_tokens,
  sum(answer_count)::text as answer_count`;

/**
 * Usage in Postgres, in the tables created by
 * `migrations/0100_model_proxy_and_usage.sql`. Adding is one upsert that
 * adds to the hour's row, so concurrent answers, on any instance, all
 * count. Sums come back as text, since Postgres adds bigints into numerics.
 */
export class PostgresModelUsageStore implements ModelUsageStore {
  readonly #pool: Pool;
  readonly #usage: string;
  readonly #caps: string;

  constructor(pool: Pool, schema: string = databaseSchema) {
    this.#pool = pool;
    this.#usage = `${escapeIdentifier(schema)}.model_usage`;
    this.#caps = `${escapeIdentifier(schema)}.model_usage_caps`;
  }

  async add(usage: AnswerUsage): Promise<void> {
    await this.#pool.query(
      `insert into ${this.#usage} (user_id, thread_id, provider_id, model_id, source, hour,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, answer_count)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)
        on conflict (user_id, thread_id, provider_id, model_id, source, hour) do update set
          input_tokens = ${this.#usage}.input_tokens + excluded.input_tokens,
          output_tokens = ${this.#usage}.output_tokens + excluded.output_tokens,
          cache_read_tokens = ${this.#usage}.cache_read_tokens + excluded.cache_read_tokens,
          cache_write_tokens = ${this.#usage}.cache_write_tokens + excluded.cache_write_tokens,
          answer_count = ${this.#usage}.answer_count + 1`,
      [
        usage.ownerUserId,
        usage.threadId,
        usage.providerId,
        usage.modelId,
        usage.source,
        hourOf(usage.at),
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
      ],
    );
  }

  async countCappedTokensSince(ownerUserId: string, since: Date): Promise<number> {
    const result = await this.#pool.query<{ total: string | null }>(
      `select sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)::text as total
        from ${this.#usage}
        where user_id = $1 and hour >= $2 and source <> 'reported'`,
      [ownerUserId, hourOf(since)],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async listForUserSince(ownerUserId: string, since: Date): Promise<ModelUsageTotals[]> {
    const result = await this.#pool.query<TotalsRow>(
      `select ${summedColumns} from ${this.#usage}
        where user_id = $1 and hour >= $2
        group by provider_id, model_id, source
        order by provider_id, model_id, source`,
      [ownerUserId, hourOf(since)],
    );
    return result.rows.map(toTotals);
  }

  async listForThread(ownerUserId: string, threadId: string): Promise<ModelUsageTotals[]> {
    const result = await this.#pool.query<TotalsRow>(
      `select ${summedColumns} from ${this.#usage}
        where user_id = $1 and thread_id = $2
        group by provider_id, model_id, source
        order by provider_id, model_id, source`,
      [ownerUserId, threadId],
    );
    return result.rows.map(toTotals);
  }

  async readOwnCap(ownerUserId: string): Promise<number | undefined> {
    const result = await this.#pool.query<{ cap_tokens: string }>(
      `select cap_tokens::text as cap_tokens from ${this.#caps} where user_id = $1`,
      [ownerUserId],
    );
    const capTokens = result.rows[0]?.cap_tokens;
    return capTokens === undefined ? undefined : Number(capTokens);
  }

  async setOwnCap(ownerUserId: string, capTokens: number | undefined): Promise<void> {
    if (capTokens === undefined) {
      await this.#pool.query(`delete from ${this.#caps} where user_id = $1`, [ownerUserId]);
      return;
    }
    await this.#pool.query(
      `insert into ${this.#caps} (user_id, cap_tokens) values ($1, $2)
        on conflict (user_id) do update set cap_tokens = excluded.cap_tokens`,
      [ownerUserId, capTokens],
    );
  }
}

function toTotals(row: TotalsRow): ModelUsageTotals {
  return {
    providerId: row.provider_id,
    modelId: row.model_id,
    source: row.source,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    answerCount: Number(row.answer_count),
  };
}
