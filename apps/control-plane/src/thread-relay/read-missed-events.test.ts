import type { RecordedThreadEvent } from "@barrack/protocol";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { toolExecutionStarted } from "../test-support/example-agent-events.js";
import { InMemoryThreadEventLog } from "../thread-event-log/in-memory-thread-event-log.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import { findMissedRange, readMissedEvents, replayPageSize } from "./read-missed-events.js";

const threadId = "thread-1";
const silentLogger = pino({ level: "silent" });

async function logHoldingEvents(count: number): Promise<InMemoryThreadEventLog> {
  const log = new InMemoryThreadEventLog();
  for (let index = 1; index <= count; index += 1) {
    await log.append(threadId, toolExecutionStarted(`call-${index}`));
  }
  return log;
}

async function collect(events: AsyncIterable<RecordedThreadEvent>): Promise<number[]> {
  const sequences = [];
  for await (const recordedEvent of events) {
    sequences.push(recordedEvent.sequence);
  }
  return sequences;
}

describe("the range a reconnecting client missed", () => {
  it("runs from just after its last seen sequence to the newest one", async () => {
    const log = await logHoldingEvents(5);

    expect(await findMissedRange(log, threadId, 2, silentLogger)).toEqual({
      afterSequence: 2,
      lastSequence: 5,
    });
  });

  it("is empty for a client that has seen everything", async () => {
    const log = await logHoldingEvents(5);

    expect(await findMissedRange(log, threadId, 5, silentLogger)).toEqual({
      afterSequence: 5,
      lastSequence: 5,
    });
  });

  it("is the whole thread for a client claiming more than the log holds", async () => {
    const log = await logHoldingEvents(2);

    expect(await findMissedRange(log, threadId, 7, silentLogger)).toEqual({
      afterSequence: 0,
      lastSequence: 2,
    });
  });
});

describe("reading the events a client missed", () => {
  it("yields exactly the range, across as many pages as it takes", async () => {
    const log = await logHoldingEvents(replayPageSize * 3);
    const range = { afterSequence: 10, lastSequence: replayPageSize * 2 + 5 };

    const sequences = await collect(readMissedEvents(log, threadId, range));

    expect(sequences).toEqual(
      Array.from({ length: range.lastSequence - range.afterSequence }, (_, index) => index + 11),
    );
  });

  it("fails rather than skip a sequence the log did not return", async () => {
    const holdingLog = await logHoldingEvents(5);
    const logMissingSequenceThree: ThreadEventLog = {
      append: (id, event) => holdingLog.append(id, event),
      readNewestSequence: (id) => holdingLog.readNewestSequence(id),
      readEvents: async (id, page) =>
        (await holdingLog.readEvents(id, page)).filter((event) => event.sequence !== 3),
    };

    await expect(
      collect(
        readMissedEvents(logMissingSequenceThree, threadId, { afterSequence: 0, lastSequence: 5 }),
      ),
    ).rejects.toThrow("returned sequence 4 where 3 was expected");
  });
});
