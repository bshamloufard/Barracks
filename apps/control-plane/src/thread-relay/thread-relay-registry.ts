import type { Logger } from "../logger.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type { ThreadAccess } from "../threads/thread-access.js";
import type { ClientConnection, SupervisorConnection } from "./connections.js";
import { ThreadRelay } from "./thread-relay.js";

/**
 * Hands out the one relay for each thread, creating it the first time a
 * supervisor or client connects. The WebSocket endpoints admit supervisors
 * only with their thread's token, and clients only with a `ThreadAccess`.
 *
 * A relay is dropped as soon as it has no supervisor, no clients and no
 * queued work, so the map holds only threads someone is connected to. The
 * history lives in the event log, so dropping a relay loses at most the text
 * of a message that was still streaming when its supervisor went away, which
 * is not part of the record (see `InProgressAssistantText`).
 *
 * Peers attach through the registry, which finds or creates the relay and
 * attaches the peer in one synchronous step. A relay is therefore never
 * dropped between being handed out and having its peer attached.
 */
export class ThreadRelayRegistry {
  readonly #threadEventLog: ThreadEventLog;
  readonly #logger: Logger;
  readonly #relaysByThreadId = new Map<string, ThreadRelay>();

  constructor(threadEventLog: ThreadEventLog, logger: Logger) {
    this.#threadEventLog = threadEventLog;
    this.#logger = logger;
  }

  /** Returns the relay the supervisor is now attached to. */
  attachSupervisor(threadId: string, connection: SupervisorConnection): ThreadRelay {
    const relay = this.#relayFor(threadId);
    relay.attachSupervisor(connection);
    return relay;
  }

  /**
   * Returns the relay the client is now attached to. It takes proof that the
   * client's user owns the thread, so no client is attached without that
   * check.
   */
  attachClient(
    access: ThreadAccess,
    connection: ClientConnection,
    lastSeenSequence: number,
  ): ThreadRelay {
    const relay = this.#relayFor(access.threadId);
    relay.attachClient(connection, lastSeenSequence);
    return relay;
  }

  #relayFor(threadId: string): ThreadRelay {
    const existingRelay = this.#relaysByThreadId.get(threadId);
    if (existingRelay !== undefined) {
      return existingRelay;
    }
    const logger = this.#logger.child({ threadId });
    const relay: ThreadRelay = new ThreadRelay({
      threadId,
      threadEventLog: this.#threadEventLog,
      logger,
      whenUnused: () => this.#drop(relay, logger),
    });
    this.#relaysByThreadId.set(threadId, relay);
    return relay;
  }

  /**
   * A relay already dropped can still report itself unused, when a peer's
   * socket finishes closing late, so only the thread's current relay is
   * removed.
   */
  #drop(relay: ThreadRelay, logger: Logger): void {
    if (this.#relaysByThreadId.get(relay.threadId) !== relay) {
      return;
    }
    this.#relaysByThreadId.delete(relay.threadId);
    logger.info("Dropped the thread's relay, which has no connections left");
  }
}
