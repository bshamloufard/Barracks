import type { ThreadEvent } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";

/**
 * The behaviour every `ThreadEventLog` must have. Each implementation's test
 * file calls this with a function that creates a fresh, empty log, so the
 * in-memory log and the database-backed one are held to the same rules.
 */
export function describeThreadEventLogContract(
  implementationName: string,
  createEmptyLog: () => Promise<ThreadEventLog>,
): void {
  describe(`${implementationName} as a thread event log`, () => {
    it("assigns sequence 1 to a thread's first event", async () => {
      const log = await createEmptyLog();

      const recorded = await log.append("thread-a", userMessageNumbered(1));

      expect(recorded.sequence).toBe(1);
    });

    it("assigns each later event the next sequence with no gaps", async () => {
      const log = await createEmptyLog();

      const sequences = [];
      for (const number of [1, 2, 3, 4]) {
        sequences.push((await log.append("thread-a", userMessageNumbered(number))).sequence);
      }

      expect(sequences).toEqual([1, 2, 3, 4]);
    });

    it("numbers each thread's events independently", async () => {
      const log = await createEmptyLog();

      await log.append("thread-a", userMessageNumbered(1));
      await log.append("thread-a", userMessageNumbered(2));
      const firstOfOtherThread = await log.append("thread-b", userMessageNumbered(3));

      expect(firstOfOtherThread.sequence).toBe(1);
    });

    it("gives concurrent appends to one thread distinct sequences with no gaps", async () => {
      const log = await createEmptyLog();

      const recorded = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          log.append("thread-a", userMessageNumbered(index + 1)),
        ),
      );

      const sortedSequences = recorded
        .map((event) => event.sequence)
        .sort((first, second) => first - second);
      expect(sortedSequences).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    });

    it("records when each event was appended as a UTC timestamp", async () => {
      const log = await createEmptyLog();
      const before = Date.now();

      const recorded = await log.append("thread-a", userMessageNumbered(1));

      expect(recorded.recordedAt).toMatch(/Z$/);
      expect(Date.parse(recorded.recordedAt)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(recorded.recordedAt)).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it("reads back the events exactly as they were appended", async () => {
      const log = await createEmptyLog();
      const event: ThreadEvent = {
        type: "tool_execution_finished",
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
        output: { text: "hello\n", isTruncated: false, originalSizeInBytes: 6 },
        durationInMilliseconds: 12,
      };

      const recorded = await log.append("thread-a", event);

      expect(await log.readAfter("thread-a", 0)).toEqual([recorded]);
      expect(recorded.event).toEqual(event);
    });

    it("reads only the events after the given sequence, in sequence order", async () => {
      const log = await createEmptyLog();
      for (const number of [1, 2, 3, 4, 5]) {
        await log.append("thread-a", userMessageNumbered(number));
      }

      const events = await log.readAfter("thread-a", 2);

      expect(events.map((recorded) => recorded.sequence)).toEqual([3, 4, 5]);
      expect(events.map((recorded) => recorded.event)).toEqual([
        userMessageNumbered(3),
        userMessageNumbered(4),
        userMessageNumbered(5),
      ]);
    });

    it("reads nothing after the newest sequence", async () => {
      const log = await createEmptyLog();
      await log.append("thread-a", userMessageNumbered(1));

      expect(await log.readAfter("thread-a", 1)).toEqual([]);
      expect(await log.readAfter("thread-a", 7)).toEqual([]);
    });

    it("reads nothing from a thread that has no events", async () => {
      const log = await createEmptyLog();
      await log.append("thread-a", userMessageNumbered(1));

      expect(await log.readAfter("thread-b", 0)).toEqual([]);
    });
  });
}

function userMessageNumbered(number: number): ThreadEvent {
  return { type: "user_message", messageId: `message-${number}`, text: `Message ${number}` };
}
