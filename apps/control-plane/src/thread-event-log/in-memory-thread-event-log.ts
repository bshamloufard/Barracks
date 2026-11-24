import type { RecordedThreadEvent, ThreadEvent } from "@barrack/protocol";
import type { ThreadEventLog } from "./thread-event-log.js";

/**
 * Keeps every thread's history in process memory, for Milestone 1 and for
 * tests. History is lost when the process exits.
 */
export class InMemoryThreadEventLog implements ThreadEventLog {
  readonly #eventsByThreadId = new Map<string, RecordedThreadEvent[]>();

  async append(threadId: string, event: ThreadEvent): Promise<RecordedThreadEvent> {
    const threadEvents = this.#eventsByThreadId.get(threadId) ?? [];
    this.#eventsByThreadId.set(threadId, threadEvents);
    // The sequence is derived and the event stored in one synchronous step,
    // so concurrent appends can never be given the same sequence.
    const recordedEvent: RecordedThreadEvent = {
      sequence: threadEvents.length + 1,
      recordedAt: new Date().toISOString(),
      event,
    };
    threadEvents.push(recordedEvent);
    return recordedEvent;
  }

  async readAfter(threadId: string, afterSequence: number): Promise<RecordedThreadEvent[]> {
    const threadEvents = this.#eventsByThreadId.get(threadId) ?? [];
    // Sequence n is stored at index n - 1, so the events after `afterSequence`
    // start at index `afterSequence`.
    return threadEvents.slice(Math.max(afterSequence, 0));
  }
}
