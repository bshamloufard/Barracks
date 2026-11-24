import type { RecordedThreadEvent, ThreadEvent } from "@barrack/protocol";
import type { ThreadEventLog, ThreadEventPage } from "./thread-event-log.js";

/**
 * Keeps every thread's history in process memory, for local development and
 * for tests. History is lost when the process exits.
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

  async readNewestSequence(threadId: string): Promise<number> {
    return this.#eventsByThreadId.get(threadId)?.length ?? 0;
  }

  async readEvents(threadId: string, page: ThreadEventPage): Promise<RecordedThreadEvent[]> {
    const threadEvents = this.#eventsByThreadId.get(threadId) ?? [];
    // Sequence n is stored at index n - 1, so the events after `afterSequence`
    // start at index `afterSequence`, and `throughSequence` is the index just
    // past the last one wanted.
    const start = Math.max(page.afterSequence, 0);
    const end = Math.min(page.throughSequence, start + page.limit);
    return threadEvents.slice(start, Math.max(end, start));
  }
}
