import type {
  AgentFailedEvent,
  RecordedThreadEvent,
  SupervisorEvent,
  ThreadEvent,
  UserMessageEvent,
} from "@barrack/protocol";
import { DatabaseError, escapeIdentifier, type Pool } from "pg";
import { type RunBoundary, runBoundaryOf } from "./run-boundary.js";
import type {
  AgentWork,
  OpenRun,
  PublicationOutcomeAppendOutcome,
  PublicationOutcomeEvent,
  SupervisorEventAppendOutcome,
  SupervisorEventOrigin,
  SupervisorResumePoint,
  ThreadEventLog,
  ThreadEventPage,
  UserMessageAppendOutcome,
} from "./thread-event-log.js";

/** The schema the control plane's tables live in; see the first migration for why it is not `public`. */
export const databaseSchema = "barrack";

/** The index that stops a supervisor's event being recorded twice; see migration 0010. */
const oneRowPerSupervisorEventIndex = "thread_events_one_per_supervisor_event";

/** The index that stops a user message being recorded twice; see migration 0060. */
const oneRowPerUserMessageIndex = "thread_events_one_per_user_message";

/** The index that stops a publication's outcome being recorded twice; see migration 0070. */
const oneRowPerPublicationIndex = "thread_events_one_per_publication";

/** https://www.postgresql.org/docs/current/errcodes-appendix.html */
const uniqueViolationCode = "23505";

/**
 * Postgres returns `bigint` columns as strings, because they can exceed what
 * a JavaScript number holds exactly. A thread would need 2^53 events first.
 */
type StoredEventRow = { sequence: string; recorded_at: Date; event: ThreadEvent };

type AppendedEventRow = Omit<StoredEventRow, "event">;

type ResumePointRow = {
  last_sequence: string | null;
  user_messages_delivered_through: string | null;
  open_run_supervisor_instance_id: string | null;
  last_recorded_event_number: string;
};

/**
 * Keeps every thread's history in Postgres, in the tables created by the
 * migrations `0001_create_thread_event_log.sql` and extended since. Safe to
 * share one database between several control plane instances: appends from
 * all of them to one thread still get gapless sequences that commit in
 * order, and each supervisor event, user message and publication outcome
 * is recorded once however many of them append it.
 */
export class PostgresThreadEventLog implements ThreadEventLog {
  readonly #pool: Pool;
  readonly #qualifiedSchema: string;
  readonly #appendStatement: string;
  readonly #closeOpenRunStatement: string;
  readonly #readNewestSequenceStatement: string;
  readonly #readOpenRunStartStatement: string;
  readonly #readEventsStatement: string;
  readonly #readResumePointStatement: string;
  readonly #readUserMessagesDeliveredStatement: string;
  readonly #readUserMessageStatement: string;
  readonly #recordUserMessagesDeliveredStatement: string;

  constructor(pool: Pool, schema: string = databaseSchema) {
    this.#pool = pool;
    const qualifiedSchema = escapeIdentifier(schema);
    this.#qualifiedSchema = qualifiedSchema;
    this.#appendStatement = appendStatementFor(qualifiedSchema);
    this.#closeOpenRunStatement = closeOpenRunStatementFor(qualifiedSchema);
    this.#readNewestSequenceStatement = `select last_sequence from ${qualifiedSchema}.thread_sequence_counters where thread_id = $1`;
    this.#readOpenRunStartStatement = openRunStartStatementFor(qualifiedSchema);
    this.#readEventsStatement = `select sequence, recorded_at, event from ${qualifiedSchema}.thread_events
      where thread_id = $1 and sequence > $2 and sequence <= $3
      order by sequence
      limit $4`;
    this.#readResumePointStatement = resumePointStatementFor(qualifiedSchema);
    this.#readUserMessageStatement = `select sequence, recorded_at, event from ${qualifiedSchema}.thread_events
      where thread_id = $1 and user_message_id = $2`;
    this.#readUserMessagesDeliveredStatement = `select user_messages_delivered_through from ${qualifiedSchema}.thread_sequence_counters where thread_id = $1`;
    // Only a thread with history has a counter row, and only a thread with
    // a user message has anything to deliver, so there is no row to create.
    this.#recordUserMessagesDeliveredStatement = `update ${qualifiedSchema}.thread_sequence_counters
      set user_messages_delivered_through = greatest(user_messages_delivered_through, $2)
      where thread_id = $1`;
  }

  /** Lets the unique index decide, as `appendSupervisorEvent` does, then reads the message it kept. */
  async appendUserMessage(
    threadId: string,
    event: UserMessageEvent,
  ): Promise<UserMessageAppendOutcome> {
    try {
      const recordedEvent = await this.#insert(threadId, event, { userMessageId: event.messageId });
      return { isAlreadyRecorded: false, recordedEvent };
    } catch (error) {
      if (!isDuplicate(error, oneRowPerUserMessageIndex)) {
        throw error;
      }
    }
    const result = await this.#pool.query<StoredEventRow>(this.#readUserMessageStatement, [
      threadId,
      event.messageId,
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("A user message reported as already recorded could not be read");
    }
    return { isAlreadyRecorded: true, recordedEvent: toRecordedEvent(row) };
  }

  /**
   * Tries the insert and lets the unique index decide, rather than looking
   * first: a look and an insert are two steps another control plane can come
   * between, while the index is checked as part of the insert itself.
   */
  async appendSupervisorEvent(
    threadId: string,
    event: SupervisorEvent,
    origin: SupervisorEventOrigin,
  ): Promise<SupervisorEventAppendOutcome> {
    try {
      const recordedEvent = await this.#insert(threadId, event, { origin });
      return { isAlreadyRecorded: false, recordedEvent };
    } catch (error) {
      if (isDuplicate(error, oneRowPerSupervisorEventIndex)) {
        return { isAlreadyRecorded: true };
      }
      throw error;
    }
  }

  /** Lets the unique index decide, as `appendSupervisorEvent` does. */
  async appendPublicationOutcome(
    threadId: string,
    event: PublicationOutcomeEvent,
    publicationId: string,
  ): Promise<PublicationOutcomeAppendOutcome> {
    try {
      const recordedEvent = await this.#insert(threadId, event, { publicationId });
      return { isAlreadyRecorded: false, recordedEvent };
    } catch (error) {
      if (isDuplicate(error, oneRowPerPublicationIndex)) {
        return { isAlreadyRecorded: true };
      }
      throw error;
    }
  }

  async closeOpenRun(
    threadId: string,
    run: OpenRun,
    event: AgentFailedEvent,
  ): Promise<RecordedThreadEvent | undefined> {
    const result = await this.#pool.query<AppendedEventRow>(this.#closeOpenRunStatement, [
      threadId,
      JSON.stringify(event),
      run.openedBySupervisorInstanceId,
    ]);
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { sequence: Number(row.sequence), recordedAt: row.recorded_at.toISOString(), event };
  }

  async readOpenRun(threadId: string): Promise<OpenRun | undefined> {
    const result = await this.#pool.query<{ open_run_supervisor_instance_id: string | null }>(
      `select open_run_supervisor_instance_id from ${this.#qualifiedSchema}.thread_sequence_counters
        where thread_id = $1`,
      [threadId],
    );
    const openedBy = result.rows[0]?.open_run_supervisor_instance_id ?? undefined;
    return openedBy === undefined ? undefined : { openedBySupervisorInstanceId: openedBy };
  }

  /** See `openRunStartStatementFor`. */
  async readOpenRunStart(threadId: string): Promise<number | undefined> {
    const result = await this.#pool.query<{ sequence: string }>(this.#readOpenRunStartStatement, [
      threadId,
    ]);
    const sequence = result.rows[0]?.sequence;
    return sequence === undefined ? undefined : Number(sequence);
  }

  async readNewestSequence(threadId: string): Promise<number> {
    const result = await this.#pool.query<{ last_sequence: string }>(
      this.#readNewestSequenceStatement,
      [threadId],
    );
    return Number(result.rows[0]?.last_sequence ?? 0);
  }

  /**
   * Events are not validated against the protocol on the way out: only the
   * append methods write them, and the relay validated each one on the way in.
   */
  async readEvents(threadId: string, page: ThreadEventPage): Promise<RecordedThreadEvent[]> {
    const result = await this.#pool.query<StoredEventRow>(this.#readEventsStatement, [
      threadId,
      page.afterSequence,
      page.throughSequence,
      page.limit,
    ]);
    return result.rows.map(toRecordedEvent);
  }

  async readSupervisorResumePoint(
    threadId: string,
    supervisorInstanceId: string,
  ): Promise<SupervisorResumePoint> {
    const result = await this.#pool.query<ResumePointRow>(this.#readResumePointStatement, [
      threadId,
      supervisorInstanceId,
    ]);
    const row = result.rows[0];
    return {
      newestSequence: Number(row?.last_sequence ?? 0),
      lastRecordedEventNumber: Number(row?.last_recorded_event_number ?? 0),
      userMessagesDeliveredThrough: Number(row?.user_messages_delivered_through ?? 0),
      openRunSupervisorInstanceId: row?.open_run_supervisor_instance_id ?? undefined,
    };
  }

  async readUserMessagesDeliveredThrough(threadId: string): Promise<number> {
    const result = await this.#pool.query<{ user_messages_delivered_through: string }>(
      this.#readUserMessagesDeliveredStatement,
      [threadId],
    );
    return Number(result.rows[0]?.user_messages_delivered_through ?? 0);
  }

  async recordUserMessagesDelivered(threadId: string, throughSequence: number): Promise<void> {
    await this.#pool.query(this.#recordUserMessagesDeliveredStatement, [threadId, throughSequence]);
  }

  async readAgentWork(threadId: string): Promise<AgentWork> {
    const result = await this.#pool.query<{
      has_open_run: boolean;
      has_undelivered_user_message: boolean;
    }>(
      `select open_run_supervisor_instance_id is not null as has_open_run,
          last_user_message_sequence > user_messages_delivered_through as has_undelivered_user_message
        from ${this.#qualifiedSchema}.thread_sequence_counters where thread_id = $1`,
      [threadId],
    );
    const row = result.rows[0];
    return {
      hasOpenRun: row?.has_open_run ?? false,
      hasUndeliveredUserMessage: row?.has_undelivered_user_message ?? false,
    };
  }

  async findThreadsWithOpenRuns(threadIds: readonly string[]): Promise<Set<string>> {
    const result = await this.#pool.query<{ thread_id: string }>(
      `select thread_id from ${this.#qualifiedSchema}.thread_sequence_counters
        where thread_id = any($1::text[]) and open_run_supervisor_instance_id is not null`,
      [threadIds],
    );
    return new Set(result.rows.map((row) => row.thread_id));
  }

  /** One statement, so the events and their counter row go together or not at all. */
  async deleteHistory(threadId: string): Promise<void> {
    await this.#pool.query(
      `with removed_events as (
          delete from ${this.#qualifiedSchema}.thread_events where thread_id = $1
        )
        delete from ${this.#qualifiedSchema}.thread_sequence_counters where thread_id = $1`,
      [threadId],
    );
  }

  /**
   * The event is sent as JSON text and not read back, so a large tool
   * output crosses the network once.
   */
  async #insert(
    threadId: string,
    event: ThreadEvent,
    key: { origin?: SupervisorEventOrigin; userMessageId?: string; publicationId?: string },
  ): Promise<RecordedThreadEvent> {
    const { origin } = key;
    const boundary: RunBoundary = runBoundaryOf(event);
    const result = await this.#pool.query<AppendedEventRow>(this.#appendStatement, [
      threadId,
      JSON.stringify(event),
      origin?.supervisorInstanceId ?? null,
      origin?.eventNumber ?? null,
      boundary,
      event.type === "user_message",
      key.userMessageId ?? null,
      key.publicationId ?? null,
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("Appending a thread event returned no row");
    }
    return { sequence: Number(row.sequence), recordedAt: row.recorded_at.toISOString(), event };
  }
}

function isDuplicate(error: unknown, uniqueIndex: string): boolean {
  return (
    error instanceof DatabaseError &&
    error.code === uniqueViolationCode &&
    error.constraint === uniqueIndex
  );
}

function toRecordedEvent(row: StoredEventRow): RecordedThreadEvent {
  return {
    sequence: Number(row.sequence),
    recordedAt: row.recorded_at.toISOString(),
    event: row.event,
  };
}

/**
 * One statement, so one transaction, does the whole append. Its first part
 * creates the thread's counter row or adds one to it, which locks the row
 * until the statement commits; a concurrent append to the same thread waits
 * on that lock, then sees the committed counter. So sequences are gapless
 * (a failed insert, a duplicate supervisor event included, rolls the counter
 * back with it), start at 1, and commit in sequence order. `clock_timestamp()`
 * is read after the lock is taken, unlike `now()`, which is fixed when the
 * statement starts, so recorded times never go backwards as sequences go
 * forwards.
 *
 * The same update keeps the counter row's open run in step with the event
 * ($5 is its run boundary): a run start records the supervisor that sent
 * it, and a run end clears it. It also remembers the newest user message
 * ($6 says whether this is one), so whether one waits to be delivered is
 * known without reading events. $7 is the identifier of a user message,
 * and $8 that of a publication whose outcome this is, which their unique
 * indexes check.
 */
function appendStatementFor(qualifiedSchema: string): string {
  return `with assigned as (
      insert into ${qualifiedSchema}.thread_sequence_counters as counter
        (thread_id, last_sequence, open_run_supervisor_instance_id, last_user_message_sequence)
      values (
        $1::text,
        1,
        case when $5::text = 'opens_run' then $3::text end,
        case when $6::boolean then 1 else 0 end
      )
      on conflict (thread_id) do update set
        last_sequence = counter.last_sequence + 1,
        open_run_supervisor_instance_id = case $5::text
          when 'opens_run' then $3::text
          when 'closes_run' then null
          else counter.open_run_supervisor_instance_id
        end,
        last_user_message_sequence = case
          when $6::boolean then counter.last_sequence + 1
          else counter.last_user_message_sequence
        end
      returning counter.last_sequence as sequence
    )
    insert into ${qualifiedSchema}.thread_events
      (thread_id, sequence, recorded_at, event, supervisor_instance_id, supervisor_event_number,
        user_message_id, publication_id)
    select $1::text, assigned.sequence, clock_timestamp(), $2::json, $3::text, $4::bigint, $7::text,
      $8::text
    from assigned
    returning sequence, recorded_at`;
}

/**
 * Appends a run's end only if the run is still open and was opened by the
 * instance given ($3), in one statement. The update locks the thread's
 * counter row; one waiting on another's lock checks its condition again
 * against the row as the other left it, so of two tries to close one run
 * the second finds it closed, and inserts nothing.
 * https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED
 */
function closeOpenRunStatementFor(qualifiedSchema: string): string {
  return `with closed as (
      update ${qualifiedSchema}.thread_sequence_counters as counter set
        last_sequence = counter.last_sequence + 1,
        open_run_supervisor_instance_id = null
      where counter.thread_id = $1::text and counter.open_run_supervisor_instance_id = $3::text
      returning counter.last_sequence as sequence
    )
    insert into ${qualifiedSchema}.thread_events (thread_id, sequence, recorded_at, event)
    select $1::text, closed.sequence, clock_timestamp(), $2::json
    from closed
    returning sequence, recorded_at`;
}

/**
 * The newest `agent_run_started` while the counter row says a run is open:
 * every run start opens a run, so that one began the run open now. Found
 * from the index of run starts alone (migration 0130), by the event as it
 * is stored, whatever follows it.
 */
export function openRunStartStatementFor(qualifiedSchema: string): string {
  return `select recorded.sequence from ${qualifiedSchema}.thread_events as recorded
    join ${qualifiedSchema}.thread_sequence_counters as counter
      on counter.thread_id = recorded.thread_id
    where recorded.thread_id = $1
      and counter.open_run_supervisor_instance_id is not null
      and (recorded.event::text like '{"type":"agent_run_started"}'
        or recorded.event::text like '{"type":"agent_run_started",%')
    order by recorded.sequence desc
    limit 1`;
}

/**
 * Everything a connecting supervisor is checked against, in one round trip.
 * The largest event number comes from the unique index on supervisor
 * events, so it is found without reading any event.
 */
function resumePointStatementFor(qualifiedSchema: string): string {
  return `select
      counter.last_sequence,
      counter.user_messages_delivered_through,
      counter.open_run_supervisor_instance_id,
      coalesce((
        select max(supervisor_event_number) from ${qualifiedSchema}.thread_events
        where thread_id = $1 and supervisor_instance_id = $2
      ), 0) as last_recorded_event_number
    from (select 1) as always_one_row
    left join ${qualifiedSchema}.thread_sequence_counters as counter on counter.thread_id = $1`;
}
