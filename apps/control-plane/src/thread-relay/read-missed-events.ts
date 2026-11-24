import type { RecordedThreadEvent } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";

/**
 * How many events a replay reads from the log at once. Most events are
 * small; the large ones that recur are tool outputs of up to 64 Ki
 * characters, so a page of 100 of those is about 13 MB of JavaScript strings
 * per replaying client. Yet a thread of 10,000 events takes only 100 reads,
 * each much quicker than sending its page to the client, which the replay
 * waits for anyway.
 */
export const replayPageSize = 100;

/** The inclusive range of sequences a replay covers; empty when `lastSequence` is `afterSequence`. */
export type MissedRange = {
  /** The replay covers the events after this sequence. */
  afterSequence: number;
  lastSequence: number;
};

/**
 * The range of events a client reconnecting with `lastSeenSequence` has not
 * seen: everything after it, up to the newest event recorded now.
 *
 * A client can claim a sequence the log does not hold, when the log has lost
 * history the client saw, such as when the in-memory log is lost in a
 * restart or a database is replaced. Sequences start at 1 and have no gaps,
 * so that is any claim beyond the newest sequence. Replaying only what
 * comes after it would leave that client silently ignoring every new event
 * as already seen, so it is replayed the whole thread instead. The
 * announcement then starts at or before its last seen sequence, which tells
 * it to discard what it holds.
 */
export async function findMissedRange(
  threadEventLog: ThreadEventLog,
  threadId: string,
  lastSeenSequence: number,
  logger: Logger,
): Promise<MissedRange> {
  const newestSequence = await threadEventLog.readNewestSequence(threadId);
  if (lastSeenSequence > newestSequence) {
    logger.warn(
      { lastSeenSequence, newestSequence },
      "A client has seen an event this log does not hold; replaying the whole thread",
    );
    return { afterSequence: 0, lastSequence: newestSequence };
  }
  return { afterSequence: lastSeenSequence, lastSequence: newestSequence };
}

/**
 * Yields exactly the events of `range`, in order, reading them a page at a
 * time. A log that skips a sequence the range promised would break the
 * protocol's promise to the client, so that fails the replay instead.
 */
export async function* readMissedEvents(
  threadEventLog: ThreadEventLog,
  threadId: string,
  range: MissedRange,
): AsyncGenerator<RecordedThreadEvent> {
  let previousSequence = range.afterSequence;
  while (previousSequence < range.lastSequence) {
    const page = await threadEventLog.readEvents(threadId, {
      afterSequence: previousSequence,
      throughSequence: range.lastSequence,
      limit: replayPageSize,
    });
    if (page.length === 0) {
      throw new Error(
        `The thread event log returned no events after sequence ${previousSequence}, though its newest is ${range.lastSequence}`,
      );
    }
    for (const recordedEvent of page) {
      if (recordedEvent.sequence !== previousSequence + 1) {
        throw new Error(
          `The thread event log returned sequence ${recordedEvent.sequence} where ${previousSequence + 1} was expected`,
        );
      }
      previousSequence = recordedEvent.sequence;
      yield recordedEvent;
    }
  }
}
