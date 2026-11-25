import type { ProviderAccess } from "@barrack/protocol";
import { escapeIdentifier, type Pool } from "pg";
import { databaseSchema } from "../thread-event-log/postgres-thread-event-log.js";
import type {
  OpenAiAccessAllowance,
  OpenAiAccessAllowanceStore,
} from "./openai-access-allowance-store.js";

type AllowanceRow = {
  thread_id: string;
  run_access: ProviderAccess;
  run_started_at_sequence: string;
  allowed_until: Date;
};

/**
 * OpenAI access allowances in Postgres, in the table created by
 * `migrations/0140_connect_a_chatgpt_plan.sql`, one row per thread,
 * removed with the thread.
 */
export class PostgresOpenAiAccessAllowanceStore implements OpenAiAccessAllowanceStore {
  readonly #pool: Pool;
  readonly #table: string;

  constructor(pool: Pool, schema: string = databaseSchema) {
    this.#pool = pool;
    this.#table = `${escapeIdentifier(schema)}.openai_access_allowances`;
  }

  async save(allowance: OpenAiAccessAllowance): Promise<void> {
    await this.#pool.query(
      `insert into ${this.#table}
          (thread_id, run_access, run_started_at_sequence, allowed_until)
        values ($1, $2, $3, $4)
        on conflict (thread_id) do update set
          run_access = excluded.run_access,
          run_started_at_sequence = excluded.run_started_at_sequence,
          allowed_until = excluded.allowed_until`,
      [
        allowance.threadId,
        allowance.runAccess,
        allowance.runStartedAtSequence,
        allowance.allowedUntil,
      ],
    );
  }

  async find(threadId: string): Promise<OpenAiAccessAllowance | undefined> {
    const result = await this.#pool.query<AllowanceRow>(
      `select thread_id, run_access, run_started_at_sequence, allowed_until
        from ${this.#table} where thread_id = $1`,
      [threadId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          threadId: row.thread_id,
          runAccess: row.run_access,
          runStartedAtSequence: Number(row.run_started_at_sequence),
          allowedUntil: row.allowed_until,
        };
  }

  async remove(threadId: string): Promise<void> {
    await this.#pool.query(`delete from ${this.#table} where thread_id = $1`, [threadId]);
  }
}
