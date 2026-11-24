import type {
  AgentEvent,
  AgentFailedEvent,
  RecordedThreadEvent,
  UserMessageEvent,
} from "@barrack/protocol";

/**
 * The durable, ordered history of every thread. It is the only place that
 * assigns sequences, so it is what makes "a reconnecting client receives
 * exactly what it missed" true.
 *
 * It also keeps the few positions that acknowledged delivery between a
 * thread's supervisor and the control plane rests on (see the handshake in
 * `packages/protocol/src/supervisor-messages.ts`), next to the history they
 * describe, so each changes in the same step as the events it is about:
 * which supervisor events are recorded, which supervisor started the run
 * still open, and how far user messages have been handed to the agent.
 *
 * Reads are bounded: a long thread holds tens of thousands of events, some
 * of them tool output tens of kilobytes long, so history is read a page at a
 * time rather than all at once.
 */
export interface ThreadEventLog {
  /*
   * Every append stores its event as the thread's next one: the log assigns
   * its sequence (1 for a thread's first event, then one more each time,
   * with no gaps) and the time it was recorded. Concurrent appends to one
   * thread each get a distinct sequence; the order between them is
   * whichever the log processes first. Each kind of append also says how a
   * second attempt to store the same thing is recognised, so that none is
   * ever stored twice.
   */

  /**
   * Stores a user's message, exactly once: a message with the same
   * identifier in the same thread is never stored twice, however often it
   * is appended, even by two control planes at once. The second and later
   * appends store nothing and report the event recorded the first time.
   */
  appendUserMessage(threadId: string, event: UserMessageEvent): Promise<UserMessageAppendOutcome>;

  /**
   * Stores an agent event a supervisor sent, exactly once: an event with the
   * same origin is never stored twice, however often it is appended, even
   * by two control planes at once. The second and later appends store
   * nothing and report that it was already recorded.
   */
  appendSupervisorEvent(
    threadId: string,
    event: AgentEvent,
    origin: SupervisorEventOrigin,
  ): Promise<SupervisorEventAppendOutcome>;

  /**
   * Stores `event` as the end of `run`, if that run is still the thread's
   * open one; otherwise stores nothing and returns undefined. This is how
   * the control plane ends a run nobody else can end (its supervisor has
   * gone, or its sandbox has stopped): the check and the append are one
   * step, so however many tries the control plane makes to close one run
   * (two instances, a stop and reconciliation) at most one end is stored,
   * none once the run's own supervisor has ended it, and a run opened
   * since is never closed by mistake.
   */
  closeOpenRun(
    threadId: string,
    run: OpenRun,
    event: AgentFailedEvent,
  ): Promise<RecordedThreadEvent | undefined>;

  /** The run open in the thread's history, or undefined if none is. */
  readOpenRun(threadId: string): Promise<OpenRun | undefined>;

  /**
   * The sequence of the thread's newest event, or 0 if it has none. Every
   * event up to and including it can be read: an event is never visible
   * here before every event ahead of it is.
   */
  readNewestSequence(threadId: string): Promise<number>;

  /**
   * At most `limit` of the thread's events with sequences after
   * `afterSequence` and up to and including `throughSequence`, in sequence
   * order, starting with the first of them.
   */
  readEvents(threadId: string, page: ThreadEventPage): Promise<RecordedThreadEvent[]>;

  /** What a supervisor instance connecting to the thread must be told, and what it must be checked against. */
  readSupervisorResumePoint(
    threadId: string,
    supervisorInstanceId: string,
  ): Promise<SupervisorResumePoint>;

  /**
   * How far the thread's user messages have been handed to an agent: the
   * largest sequence ever passed to `recordUserMessagesDelivered`, or 0.
   */
  readUserMessagesDeliveredThrough(threadId: string): Promise<number>;

  /** Notes that every user message up to `throughSequence` was handed to an agent. It never moves back. */
  recordUserMessagesDelivered(threadId: string, throughSequence: number): Promise<void>;

  /**
   * Whether the thread's agent is in the middle of a run, and whether a
   * user message is waiting to be handed to it: what decides whether its
   * sandbox may be stopped for being idle. Read without reading any event.
   */
  readAgentWork(threadId: string): Promise<AgentWork>;

  /** Which of these threads have a run open, in one read, for the thread list. */
  findThreadsWithOpenRuns(threadIds: readonly string[]): Promise<Set<string>>;

  /** Removes the thread's whole history, for good. Removing one that has none does nothing. */
  deleteHistory(threadId: string): Promise<void>;
}

export type AgentWork = {
  /** A run has started and no `agent_run_settled` or `agent_failed` has ended it. */
  hasOpenRun: boolean;
  /** A user message is recorded after the furthest delivery of user messages. */
  hasUndeliveredUserMessage: boolean;
};

export type ThreadEventPage = {
  afterSequence: number;
  throughSequence: number;
  limit: number;
};

/**
 * Identifies an agent event by where it came from: the supervisor process
 * that sent it (an identifier minted each time a supervisor starts) and its
 * number among that process's events.
 */
export type SupervisorEventOrigin = { supervisorInstanceId: string; eventNumber: number };

export type SupervisorEventAppendOutcome =
  | { isAlreadyRecorded: false; recordedEvent: RecordedThreadEvent }
  | { isAlreadyRecorded: true };

/**
 * A run open in a thread's history, named by the supervisor instance that
 * opened it: an instance's runs follow one another, and an instance never
 * comes back once its process has gone, so a run closed on that instance's
 * behalf cannot be confused with a later one.
 */
export type OpenRun = { openedBySupervisorInstanceId: string };

/** `recordedEvent` is the message as it was first recorded, whether or not by this append. */
export type UserMessageAppendOutcome = {
  isAlreadyRecorded: boolean;
  recordedEvent: RecordedThreadEvent;
};

export type SupervisorResumePoint = {
  /** As `readNewestSequence`. */
  newestSequence: number;
  /** The largest event number recorded from this supervisor instance, or 0 for none. */
  lastRecordedEventNumber: number;
  /** As `readUserMessagesDeliveredThrough`. */
  userMessagesDeliveredThrough: number;
  /**
   * The instance whose `agent_run_started` is the last run boundary in the
   * thread's history, if no `agent_run_settled` or `agent_failed` follows
   * it; undefined when no run is open.
   */
  openRunSupervisorInstanceId: string | undefined;
};
