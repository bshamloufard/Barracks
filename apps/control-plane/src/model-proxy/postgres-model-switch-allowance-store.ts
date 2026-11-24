import { escapeIdentifier, type Pool } from "pg";
import { databaseSchema } from "../thread-event-log/postgres-thread-event-log.js";
import type {
  ModelSwitchAllowance,
  ModelSwitchAllowanceStore,
} from "./model-switch-allowance-store.js";

type AllowanceRow = {
  thread_id: string;
  previous_model: string;
  run_started_at_sequence: string;
  allowed_until: Date;
};

/**
 * Model switch allowances in Postgres, in the table created by
 * `migrations/0120_allow_the_previous_model_for_its_run.sql`, one row per
 * thread, removed with the thread.
 */
export class PostgresModelSwitchAllowanceStore implements ModelSwitchAllowanceStore {
  readonly #pool: Pool;
  readonly #table: string;

  constructor(pool: Pool, schema: string = databaseSchema) {
    this.#pool = pool;
    this.#table = `${escapeIdentifier(schema)}.model_switch_allowances`;
  }

  async save(allowance: ModelSwitchAllowance): Promise<void> {
    await this.#pool.query(
      `insert into ${this.#table}
          (thread_id, previous_model, run_started_at_sequence, allowed_until)
        values ($1, $2, $3, $4)
        on conflict (thread_id) do update set
          previous_model = excluded.previous_model,
          run_started_at_sequence = excluded.run_started_at_sequence,
          allowed_until = excluded.allowed_until`,
      [
        allowance.threadId,
        allowance.previousModel,
        allowance.runStartedAtSequence,
        allowance.allowedUntil,
      ],
    );
  }

  async find(threadId: string): Promise<ModelSwitchAllowance | undefined> {
    const result = await this.#pool.query<AllowanceRow>(
      `select thread_id, previous_model, run_started_at_sequence, allowed_until
        from ${this.#table} where thread_id = $1`,
      [threadId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          threadId: row.thread_id,
          previousModel: row.previous_model,
          runStartedAtSequence: Number(row.run_started_at_sequence),
          allowedUntil: row.allowed_until,
        };
  }

  async remove(threadId: string): Promise<void> {
    await this.#pool.query(`delete from ${this.#table} where thread_id = $1`, [threadId]);
  }
}
