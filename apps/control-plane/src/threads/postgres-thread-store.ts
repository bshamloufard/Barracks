import { escapeIdentifier, type Pool } from "pg";
import { databaseSchema } from "../thread-event-log/postgres-thread-event-log.js";
import {
  type NewThread,
  type ThreadRecord,
  type ThreadSandboxRecord,
  ThreadStateConflictError,
  type ThreadStore,
} from "./thread-store.js";

type ThreadRow = {
  thread_id: string;
  owner_user_id: string | null;
  created_at: Date;
  sandbox_provider: string;
  supervisor_token_digest: Buffer;
  sandbox_state: "creating" | "ready" | "failed";
  sandbox_id: string | null;
  sandbox_failure_reason: string | null;
};

const threadColumns =
  "thread_id, owner_user_id, created_at, sandbox_provider, supervisor_token_digest, sandbox_state, sandbox_id, sandbox_failure_reason";

/**
 * Keeps thread records in Postgres, in the table created by
 * `migrations/0002_create_threads.sql`. A sandbox moves out of `creating`
 * only through an update conditional on it still being `creating`, so two
 * control planes can never both settle the same thread.
 */
export class PostgresThreadStore implements ThreadStore {
  readonly #pool: Pool;
  readonly #table: string;

  constructor(pool: Pool, schema: string = databaseSchema) {
    this.#pool = pool;
    this.#table = `${escapeIdentifier(schema)}.threads`;
  }

  /**
   * `clock_timestamp()` rather than `now()`, which is fixed at the start of
   * a transaction, so threads created one after another are ordered by it.
   */
  async create(thread: NewThread): Promise<ThreadRecord> {
    const result = await this.#pool.query<ThreadRow>(
      `insert into ${this.#table}
        (thread_id, owner_user_id, created_at, sandbox_provider, supervisor_token_digest, sandbox_state)
        values ($1, $2, clock_timestamp(), $3, $4, 'creating')
        returning ${threadColumns}`,
      [thread.threadId, thread.ownerUserId, thread.sandboxProvider, thread.supervisorTokenDigest],
    );
    return toThreadRecord(requireRow(result.rows[0], "Recording a new thread"));
  }

  async recordSandboxReady(threadId: string, sandboxId: string): Promise<void> {
    await this.#changeCreatingSandbox(
      threadId,
      "record its sandbox",
      "sandbox_state = 'ready', sandbox_id = $2",
      sandboxId,
    );
  }

  async recordSandboxFailed(threadId: string, reason: string): Promise<void> {
    await this.#changeCreatingSandbox(
      threadId,
      "record its sandbox's failure",
      "sandbox_state = 'failed', sandbox_failure_reason = $2",
      reason,
    );
  }

  async failSandboxesStillBeingCreated(reason: string): Promise<string[]> {
    const result = await this.#pool.query<Pick<ThreadRow, "thread_id">>(
      `update ${this.#table}
        set sandbox_state = 'failed', sandbox_failure_reason = $1
        where sandbox_state = 'creating'
        returning thread_id`,
      [reason],
    );
    return result.rows.map((row) => row.thread_id);
  }

  async find(threadId: string): Promise<ThreadRecord | undefined> {
    const result = await this.#pool.query<ThreadRow>(
      `select ${threadColumns} from ${this.#table} where thread_id = $1`,
      [threadId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toThreadRecord(row);
  }

  async findOwnedBy(ownerUserId: string, threadId: string): Promise<ThreadRecord | undefined> {
    const result = await this.#pool.query<ThreadRow>(
      `select ${threadColumns} from ${this.#table} where thread_id = $1 and owner_user_id = $2`,
      [threadId, ownerUserId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toThreadRecord(row);
  }

  async listNewestFirstOwnedBy(ownerUserId: string, limit: number): Promise<ThreadRecord[]> {
    const result = await this.#pool.query<ThreadRow>(
      `select ${threadColumns} from ${this.#table}
        where owner_user_id = $1
        order by created_at desc, thread_id desc
        limit $2`,
      [ownerUserId, limit],
    );
    return result.rows.map(toThreadRecord);
  }

  async #changeCreatingSandbox(
    threadId: string,
    attemptedChange: string,
    assignments: string,
    value: string,
  ): Promise<void> {
    const result = await this.#pool.query(
      `update ${this.#table} set ${assignments}
        where thread_id = $1 and sandbox_state = 'creating'`,
      [threadId, value],
    );
    if (result.rowCount !== 1) {
      throw new ThreadStateConflictError(threadId, attemptedChange);
    }
  }
}

function requireRow(row: ThreadRow | undefined, attemptedOperation: string): ThreadRow {
  if (row === undefined) {
    throw new Error(`${attemptedOperation} returned no row`);
  }
  return row;
}

function toThreadRecord(row: ThreadRow): ThreadRecord {
  return {
    threadId: row.thread_id,
    ownerUserId: row.owner_user_id ?? undefined,
    createdAt: row.created_at,
    sandboxProvider: row.sandbox_provider,
    supervisorTokenDigest: row.supervisor_token_digest,
    sandbox: toSandboxRecord(row),
  };
}

/** The table's checks guarantee the identifier and reason are present in their states. */
function toSandboxRecord(row: ThreadRow): ThreadSandboxRecord {
  switch (row.sandbox_state) {
    case "creating":
      return { state: "creating" };
    case "ready":
      return { state: "ready", sandboxId: row.sandbox_id ?? "" };
    case "failed":
      return { state: "failed", reason: row.sandbox_failure_reason ?? "" };
  }
}
