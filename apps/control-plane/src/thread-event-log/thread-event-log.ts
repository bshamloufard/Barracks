import type { RecordedThreadEvent, ThreadEvent } from "@barrack/protocol";

/**
 * The durable, ordered history of every thread. It is the only place that
 * assigns sequences, so it is what makes "a reconnecting client receives
 * exactly what it missed" true.
 *
 * Methods are asynchronous because the implementation that follows the
 * in-memory one is backed by Postgres.
 */
export interface ThreadEventLog {
  /**
   * Stores an event as the thread's next one. The log assigns its sequence (1
   * for a thread's first event, then one more each time, with no gaps) and the
   * time it was recorded. Concurrent appends to one thread each get a distinct
   * sequence; the order between them is whichever the log processes first.
   */
  append(threadId: string, event: ThreadEvent): Promise<RecordedThreadEvent>;

  /** Every event of the thread with a sequence greater than `afterSequence`, in sequence order. */
  readAfter(threadId: string, afterSequence: number): Promise<RecordedThreadEvent[]>;
}
