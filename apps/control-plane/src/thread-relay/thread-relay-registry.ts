import type { Logger } from "../logger.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import { ThreadRelay } from "./thread-relay.js";

/**
 * Hands out the one relay for each thread, creating it the first time a
 * supervisor or client connects. Milestone 1 has no thread records, so any
 * valid thread identifier names a thread.
 */
export class ThreadRelayRegistry {
  readonly #threadEventLog: ThreadEventLog;
  readonly #logger: Logger;
  readonly #relaysByThreadId = new Map<string, ThreadRelay>();

  constructor(threadEventLog: ThreadEventLog, logger: Logger) {
    this.#threadEventLog = threadEventLog;
    this.#logger = logger;
  }

  relayFor(threadId: string): ThreadRelay {
    const existingRelay = this.#relaysByThreadId.get(threadId);
    if (existingRelay !== undefined) {
      return existingRelay;
    }
    const relay = new ThreadRelay(threadId, this.#threadEventLog, this.#logger.child({ threadId }));
    this.#relaysByThreadId.set(threadId, relay);
    return relay;
  }
}
