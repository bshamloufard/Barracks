import { escapeIdentifier, type Pool, type PoolClient } from "pg";
import { insertThreadRepository } from "../repositories/postgres-thread-repository-store.js";
import { databaseSchema } from "../thread-event-log/postgres-thread-event-log.js";
import {
  type AdmissionOutcome,
  checkTransition,
  type FinishStoppingRequest,
  findBrokenLimit,
  legalSandboxTransitions,
  type NewThread,
  placeOccupyingStates,
  type SandboxAdmission,
  type SandboxState,
  type SandboxTransition,
  sandboxStates,
  type ThreadCreationOptions,
  type ThreadRecord,
  type ThreadSandboxRecord,
  type ThreadStore,
  type TransitionOutcome,
} from "./thread-store.js";

type ThreadRow = {
  thread_id: string;
  owner_user_id: string | null;
  created_at: Date;
  sandbox_provider: string;
  supervisor_token_digest: Buffer;
  taken_over_supervisor_token_digests: Buffer[];
  sandbox_state: SandboxState;
  sandbox_id: string | null;
  sandbox_failure_reason: string | null;
  sandbox_problem: string | null;
  lease_expires_at: Date | null;
  /** A `bigint`, which Postgres returns as a string. */
  state_version: string;
  title: string | null;
  last_activity_at: Date;
  wake_requested: boolean;
  model: string | null;
};

const threadColumns = `thread_id, owner_user_id, created_at, sandbox_provider,
  supervisor_token_digest, taken_over_supervisor_token_digests, sandbox_state, sandbox_id, sandbox_failure_reason, sandbox_problem,
  lease_expires_at, state_version, title, last_activity_at, wake_requested, model`;

/**
 * Keeps thread records in Postgres, in the table created by
 * `migrations/0002_create_threads.sql` and extended since. Every change of
 * state is one update conditional on the version the caller read, so two
 * control planes can never both make a change from the same reading.
 *
 * A change that takes a place under the running-sandbox limit counts the
 * places taken and makes the change in one transaction, holding a lock that
 * every such transaction takes first; otherwise two of them, each counting
 * before the other had changed anything, could both be admitted.
 */
export class PostgresThreadStore implements ThreadStore {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #table: string;
  readonly #admissionLockName: string;

  constructor(pool: Pool, schema: string = databaseSchema) {
    this.#pool = pool;
    this.#schema = schema;
    this.#table = `${escapeIdentifier(schema)}.threads`;
    this.#admissionLockName = `${schema}.sandbox_admission`;
  }

  async create(thread: NewThread, options: ThreadCreationOptions): Promise<AdmissionOutcome> {
    return this.#inTransaction(async (client) => {
      const limitReached = await this.#checkAdmission(
        client,
        thread.ownerUserId,
        thread.threadId,
        options.admission,
      );
      if (limitReached !== undefined) {
        return limitReached;
      }
      const result = await client.query<ThreadRow>(
        `insert into ${this.#table}
          (thread_id, owner_user_id, created_at, last_activity_at, sandbox_provider,
            supervisor_token_digest, sandbox_state, lease_expires_at, model)
          values ($1, $2, $3, $3, $4, $5, 'creating', $6, $7)
          returning ${threadColumns}`,
        [
          thread.threadId,
          thread.ownerUserId,
          options.at,
          thread.sandboxProvider,
          thread.supervisorTokenDigest,
          options.leaseExpiresAt,
          thread.model ?? null,
        ],
      );
      if (thread.repository !== undefined) {
        await insertThreadRepository(client, this.#schema, thread.threadId, thread.repository);
      }
      return { kind: "changed", thread: toThreadRecord(requireRow(result.rows[0])) };
    });
  }

  async transition(transition: SandboxTransition): Promise<TransitionOutcome> {
    const { admission } = transition;
    const outcome =
      admission === undefined
        ? await this.#applyTransition(this.#pool, transition)
        : await this.#inTransaction((client) =>
            this.#applyAdmittedTransition(client, transition, admission),
          );
    if (outcome.kind !== "conflict") {
      return outcome;
    }
    // Nothing changed. Read the thread to tell a race, which is the caller's
    // to handle, from a change that is never allowed, which is a bug.
    checkTransition(await this.find(transition.threadId), transition);
    return outcome;
  }

  async finishStopping(request: FinishStoppingRequest): Promise<TransitionOutcome> {
    const result = await this.#pool.query<ThreadRow>(
      `update ${this.#table} set
          sandbox_state = case when wake_requested then 'starting' else 'stopped' end,
          lease_expires_at = case when wake_requested then $3::timestamptz end,
          sandbox_problem = null,
          wake_requested = false,
          state_version = state_version + 1
        where thread_id = $1 and state_version = $2 and sandbox_state = 'stopping'
        returning ${threadColumns}`,
      [request.threadId, request.fromVersion, request.wakeLeaseExpiresAt],
    );
    const row = result.rows[0];
    return row === undefined
      ? { kind: "conflict" }
      : { kind: "changed", thread: toThreadRecord(row) };
  }

  async renewLease(threadId: string, version: number, leaseExpiresAt: Date): Promise<boolean> {
    const result = await this.#pool.query(
      `update ${this.#table} set lease_expires_at = $3
        where thread_id = $1 and state_version = $2 and lease_expires_at is not null`,
      [threadId, version, leaseExpiresAt],
    );
    return result.rowCount === 1;
  }

  async recordUserMessageArrival(
    threadId: string,
    arrival: { at: Date; title: string | undefined },
  ): Promise<ThreadRecord | undefined> {
    const result = await this.#pool.query<ThreadRow>(
      `update ${this.#table} set
          last_activity_at = $2,
          title = coalesce(title, $3),
          wake_requested = wake_requested or sandbox_state = 'stopping'
        where thread_id = $1
        returning ${threadColumns}`,
      [threadId, arrival.at, arrival.title ?? null],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toThreadRecord(row);
  }

  async recordActivity(threadId: string, at: Date): Promise<void> {
    await this.#pool.query(`update ${this.#table} set last_activity_at = $2 where thread_id = $1`, [
      threadId,
      at,
    ]);
  }

  async changeModel(
    ownerUserId: string,
    threadId: string,
    model: string,
  ): Promise<ThreadRecord | undefined> {
    const result = await this.#pool.query<ThreadRow>(
      `update ${this.#table} set model = $3
        where thread_id = $1 and owner_user_id = $2
        returning ${threadColumns}`,
      [threadId, ownerUserId, model],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toThreadRecord(row);
  }

  async remove(threadId: string, version: number): Promise<boolean> {
    const result = await this.#pool.query(
      `delete from ${this.#table}
        where thread_id = $1 and state_version = $2 and sandbox_state = 'deleting'`,
      [threadId, version],
    );
    return result.rowCount === 1;
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

  async listMostRecentlyActiveOwnedBy(ownerUserId: string, limit: number): Promise<ThreadRecord[]> {
    const result = await this.#pool.query<ThreadRow>(
      `select ${threadColumns} from ${this.#table}
        where owner_user_id = $1
        order by last_activity_at desc, thread_id desc
        limit $2`,
      [ownerUserId, limit],
    );
    return result.rows.map(toThreadRecord);
  }

  async listInStates(states: readonly SandboxState[], limit: number): Promise<ThreadRecord[]> {
    const result = await this.#pool.query<ThreadRow>(
      `select ${threadColumns} from ${this.#table}
        where sandbox_state = any($1::text[])
        order by created_at
        limit $2`,
      [states, limit],
    );
    return result.rows.map(toThreadRecord);
  }

  async listRunningInactiveSince(cutoff: Date, limit: number): Promise<ThreadRecord[]> {
    const result = await this.#pool.query<ThreadRow>(
      `select ${threadColumns} from ${this.#table}
        where sandbox_state = 'running' and last_activity_at <= $1
        order by last_activity_at
        limit $2`,
      [cutoff, limit],
    );
    return result.rows.map(toThreadRecord);
  }

  async #applyAdmittedTransition(
    client: PoolClient,
    transition: SandboxTransition,
    admission: SandboxAdmission,
  ): Promise<TransitionOutcome> {
    const owner = await client.query<Pick<ThreadRow, "owner_user_id">>(
      `select owner_user_id from ${this.#table} where thread_id = $1`,
      [transition.threadId],
    );
    const ownerRow = owner.rows[0];
    if (ownerRow === undefined) {
      return { kind: "conflict" };
    }
    const limitReached = await this.#checkAdmission(
      client,
      ownerRow.owner_user_id ?? undefined,
      transition.threadId,
      admission,
    );
    return limitReached ?? (await this.#applyTransition(client, transition));
  }

  /**
   * One conditional update: the thread must still be at the version read,
   * in a state from which the change is legal, and, for idle shutdown, not
   * active since. In the assignments, columns are their values before it.
   */
  async #applyTransition(
    queryable: Pool | PoolClient,
    transition: SandboxTransition,
  ): Promise<TransitionOutcome> {
    const { to } = transition;
    const result = await queryable.query<ThreadRow>(
      `update ${this.#table} set
          sandbox_state = $3,
          sandbox_id = $4,
          sandbox_failure_reason = $5,
          sandbox_problem = $6,
          lease_expires_at = $7,
          state_version = state_version + 1,
          wake_requested = wake_requested and sandbox_state = 'stopping' and $3 = 'stopping',
          last_activity_at = case when $3 = 'running' then $8 else last_activity_at end,
          taken_over_supervisor_token_digests = case
            when $9::bytea is null then taken_over_supervisor_token_digests
            else array_append(taken_over_supervisor_token_digests, $9::bytea)
          end
        where thread_id = $1 and state_version = $2
          and sandbox_state = any($10::text[])
          and ($11::timestamptz is null or last_activity_at = $11)
        returning ${threadColumns}`,
      [
        transition.threadId,
        transition.fromVersion,
        to.state,
        "sandboxId" in to ? (to.sandboxId ?? null) : null,
        to.state === "failed" ? to.reason : null,
        "problem" in to ? (to.problem ?? null) : null,
        "leaseExpiresAt" in to ? to.leaseExpiresAt : null,
        transition.at,
        transition.addedSupervisorTokenDigest ?? null,
        statesThatMayBecome(to.state),
        transition.onlyIfLastActiveAt ?? null,
      ],
    );
    const row = result.rows[0];
    return row === undefined
      ? { kind: "conflict" }
      : { kind: "changed", thread: toThreadRecord(row) };
  }

  /** Must run inside a transaction: the lock it takes is held until that ends. */
  async #checkAdmission(
    client: PoolClient,
    ownerUserId: string | undefined,
    admittedThreadId: string,
    admission: SandboxAdmission,
  ): Promise<AdmissionOutcome | undefined> {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      this.#admissionLockName,
    ]);
    const counts = await client.query<{ owned: string; everyone: string }>(
      `select count(*) filter (where owner_user_id = $1) as owned, count(*) as everyone
        from ${this.#table}
        where sandbox_state = any($2::text[]) and thread_id <> $3`,
      [ownerUserId ?? null, placeOccupyingStates, admittedThreadId],
    );
    const { owned, everyone } = counts.rows[0] ?? { owned: "0", everyone: "0" };
    const brokenLimit = findBrokenLimit(admission, Number(owned), Number(everyone));
    if (brokenLimit === undefined) {
      return undefined;
    }
    const occupying = await client.query<ThreadRow>(
      `select ${threadColumns} from ${this.#table}
        where owner_user_id = $1 and sandbox_state = any($2::text[]) and thread_id <> $3
        order by last_activity_at desc, thread_id desc`,
      [ownerUserId ?? null, placeOccupyingStates, admittedThreadId],
    );
    return {
      kind: "limit_reached",
      ...brokenLimit,
      occupying: occupying.rows.map(toThreadRecord),
    };
  }

  /** Commits what `work` did unless it throws; an outcome that changed nothing commits nothing. */
  async #inTransaction<Outcome>(work: (client: PoolClient) => Promise<Outcome>): Promise<Outcome> {
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      const outcome = await work(client);
      await client.query("commit");
      return outcome;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function statesThatMayBecome(target: SandboxState): SandboxState[] {
  return sandboxStates.filter((from) => legalSandboxTransitions[from].includes(target));
}

function requireRow(row: ThreadRow | undefined): ThreadRow {
  if (row === undefined) {
    throw new Error("Recording a new thread returned no row");
  }
  return row;
}

function toThreadRecord(row: ThreadRow): ThreadRecord {
  return {
    threadId: row.thread_id,
    ownerUserId: row.owner_user_id ?? undefined,
    createdAt: row.created_at,
    sandboxProvider: row.sandbox_provider,
    supervisorTokenDigests: [
      row.supervisor_token_digest,
      ...row.taken_over_supervisor_token_digests,
    ],
    sandbox: toSandboxRecord(row),
    version: Number(row.state_version),
    title: row.title ?? undefined,
    lastActivityAt: row.last_activity_at,
    isWakeRequested: row.wake_requested,
    model: row.model ?? undefined,
  };
}

/**
 * The table's checks guarantee that each state has the identifier, reason
 * and lease it needs; the fallbacks below are never used.
 */
function toSandboxRecord(row: ThreadRow): ThreadSandboxRecord {
  const sandboxId = row.sandbox_id ?? undefined;
  const leaseExpiresAt = row.lease_expires_at ?? new Date(0);
  const problem = row.sandbox_problem ?? undefined;
  switch (row.sandbox_state) {
    case "creating":
      return { state: "creating", leaseExpiresAt };
    case "running":
      return { state: "running", sandboxId: sandboxId ?? "", problem };
    case "stopping":
      return { state: "stopping", sandboxId: sandboxId ?? "", leaseExpiresAt };
    case "stopped":
      return { state: "stopped", sandboxId: sandboxId ?? "", problem };
    case "starting":
      return { state: "starting", sandboxId: sandboxId ?? "", leaseExpiresAt };
    case "failed":
      return { state: "failed", sandboxId, reason: row.sandbox_failure_reason ?? "" };
    case "deleting":
      return { state: "deleting", sandboxId, leaseExpiresAt };
  }
}
