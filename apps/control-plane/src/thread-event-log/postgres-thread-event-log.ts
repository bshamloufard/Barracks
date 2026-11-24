import type { RecordedThreadEvent, ThreadEvent } from "@barrack/protocol";
import { escapeIdentifier, type Pool } from "pg";
import type { ThreadEventLog, ThreadEventPage } from "./thread-event-log.js";

/** The schema the control plane's tables live in; see the first migration for why it is not `public`. */
export const databaseSchema = "barrack";

/**
 * Postgres returns `bigint` columns as strings, because they can exceed what
 * a JavaScript number holds exactly. A thread would need 2^53 events first.
 */
type StoredEventRow = { sequence: string; recorded_at: Date; event: ThreadEvent };

type AppendedEventRow = Omit<StoredEventRow, "event">;

/**
 * Keeps every thread's history in Postgres, in the tables created by
 * `migrations/0001_create_thread_event_log.sql`. Safe to share one database
 * between several control plane instances: appends from all of them to one
 * thread still get gapless sequences that commit in order.
 */
export class PostgresThreadEventLog implements ThreadEventLog {
  readonly #pool: Pool;
  readonly #appendStatement: string;
  readonly #readNewestSequenceStatement: string;
  readonly #readEventsStatement: string;

  constructor(pool: Pool, schema: string = databaseSchema) {
    this.#pool = pool;
    const qualifiedSchema = escapeIdentifier(schema);
    this.#appendStatement = appendStatementFor(qualifiedSchema);
    this.#readNewestSequenceStatement = `select last_sequence from ${qualifiedSchema}.thread_sequence_counters where thread_id = $1`;
    this.#readEventsStatement = `select sequence, recorded_at, event from ${qualifiedSchema}.thread_events
      where thread_id = $1 and sequence > $2 and sequence <= $3
      order by sequence
      limit $4`;
  }

  /**
   * The event is sent as JSON text and not read back, so a large tool
   * output crosses the network once.
   */
  async append(threadId: string, event: ThreadEvent): Promise<RecordedThreadEvent> {
    const result = await this.#pool.query<AppendedEventRow>(this.#appendStatement, [
      threadId,
      JSON.stringify(event),
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("Appending a thread event returned no row");
    }
    return { sequence: Number(row.sequence), recordedAt: row.recorded_at.toISOString(), event };
  }

  async readNewestSequence(threadId: string): Promise<number> {
    const result = await this.#pool.query<{ last_sequence: string }>(
      this.#readNewestSequenceStatement,
      [threadId],
    );
    return Number(result.rows[0]?.last_sequence ?? 0);
  }

  /**
   * Events are not validated against the protocol on the way out: only
   * `append` writes them, and the relay validated each one on the way in.
   */
  async readEvents(threadId: string, page: ThreadEventPage): Promise<RecordedThreadEvent[]> {
    const result = await this.#pool.query<StoredEventRow>(this.#readEventsStatement, [
      threadId,
      page.afterSequence,
      page.throughSequence,
      page.limit,
    ]);
    return result.rows.map((row) => ({
      sequence: Number(row.sequence),
      recordedAt: row.recorded_at.toISOString(),
      event: row.event,
    }));
  }
}

/**
 * One statement, so one transaction, does the whole append. Its first part
 * creates the thread's counter row or adds one to it, which locks the row
 * until the statement commits; a concurrent append to the same thread waits
 * on that lock, then sees the committed counter. So sequences are gapless
 * (a failed insert rolls the counter back with it), start at 1, and commit
 * in sequence order. `clock_timestamp()` is read after the lock is taken,
 * unlike `now()`, which is fixed when the statement starts, so recorded
 * times never go backwards as sequences go forwards.
 */
function appendStatementFor(qualifiedSchema: string): string {
  return `with assigned as (
      insert into ${qualifiedSchema}.thread_sequence_counters as counter (thread_id, last_sequence)
      values ($1::text, 1)
      on conflict (thread_id) do update set last_sequence = counter.last_sequence + 1
      returning counter.last_sequence as sequence
    )
    insert into ${qualifiedSchema}.thread_events (thread_id, sequence, recorded_at, event)
    select $1::text, assigned.sequence, clock_timestamp(), $2::json
    from assigned
    returning sequence, recorded_at`;
}
