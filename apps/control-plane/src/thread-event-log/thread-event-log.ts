import type { RecordedThreadEvent, ThreadEvent } from "@barrack/protocol";

/**
 * The durable, ordered history of every thread. It is the only place that
 * assigns sequences, so it is what makes "a reconnecting client receives
 * exactly what it missed" true.
 *
 * Reads are bounded: a long thread holds tens of thousands of events, some
 * of them tool output tens of kilobytes long, so history is read a page at a
 * time rather than all at once.
 */
export interface ThreadEventLog {
  /**
   * Stores an event as the thread's next one. The log assigns its sequence (1
   * for a thread's first event, then one more each time, with no gaps) and the
   * time it was recorded. Concurrent appends to one thread each get a distinct
   * sequence; the order between them is whichever the log processes first.
   */
  append(threadId: string, event: ThreadEvent): Promise<RecordedThreadEvent>;

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
}

export type ThreadEventPage = {
  afterSequence: number;
  throughSequence: number;
  limit: number;
};
