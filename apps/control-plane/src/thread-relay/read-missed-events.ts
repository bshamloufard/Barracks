import type { RecordedThreadEvent } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";

export type MissedEvents = {
  /** The replay covers the events after this sequence. */
  afterSequence: number;
  events: RecordedThreadEvent[];
};

/**
 * The events a client reconnecting with `lastSeenSequence` has not seen.
 *
 * A client can claim a sequence the log does not hold, when the log has lost
 * history the client saw: today that happens whenever the control plane
 * restarts, because the log is kept in memory. Replaying only what comes
 * after the claimed sequence would leave that client silently ignoring every
 * new event as already seen, so it is replayed the whole thread instead. The
 * announcement then starts at or before its last seen sequence, which tells
 * it to discard what it holds.
 */
export async function readMissedEvents(
  threadEventLog: ThreadEventLog,
  threadId: string,
  lastSeenSequence: number,
  logger: Logger,
): Promise<MissedEvents> {
  if (lastSeenSequence === 0) {
    return { afterSequence: 0, events: await threadEventLog.readAfter(threadId, 0) };
  }
  // Reading from the last seen event itself, rather than after it, proves
  // that the log holds it.
  const eventsFromLastSeen = await threadEventLog.readAfter(threadId, lastSeenSequence - 1);
  if (eventsFromLastSeen.length === 0) {
    logger.warn(
      { lastSeenSequence },
      "A client has seen an event this log does not hold; replaying the whole thread",
    );
    return { afterSequence: 0, events: await threadEventLog.readAfter(threadId, 0) };
  }
  return { afterSequence: lastSeenSequence, events: eventsFromLastSeen.slice(1) };
}
