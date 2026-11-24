import type {
  AgentEvent,
  AgentFailedEvent,
  RepositoryPublicationFailedEvent,
  RepositoryPublishedEvent,
  ThreadEvent,
  UserMessageEvent,
} from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import { readWholeThread } from "./read-whole-thread.js";
import { recordTestEvent } from "./record-test-events.js";

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

      const recorded = await recordTestEvent(log, "thread-a", userMessageNumbered(1));

      expect(recorded.sequence).toBe(1);
    });

    it("assigns each later event the next sequence with no gaps", async () => {
      const log = await createEmptyLog();

      const sequences = [];
      for (const number of [1, 2, 3, 4]) {
        sequences.push(
          (await recordTestEvent(log, "thread-a", userMessageNumbered(number))).sequence,
        );
      }

      expect(sequences).toEqual([1, 2, 3, 4]);
    });

    it("numbers each thread's events independently", async () => {
      const log = await createEmptyLog();

      await recordTestEvent(log, "thread-a", userMessageNumbered(1));
      await recordTestEvent(log, "thread-a", userMessageNumbered(2));
      const firstOfOtherThread = await recordTestEvent(log, "thread-b", userMessageNumbered(3));

      expect(firstOfOtherThread.sequence).toBe(1);
    });

    it("gives concurrent appends to one thread distinct sequences with no gaps", async () => {
      const log = await createEmptyLog();

      const recorded = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          recordTestEvent(log, "thread-a", userMessageNumbered(index + 1)),
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

      const recorded = await recordTestEvent(log, "thread-a", userMessageNumbered(1));

      expect(recorded.recordedAt).toMatch(/Z$/);
      expect(Date.parse(recorded.recordedAt)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(recorded.recordedAt)).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it("records a user message once however often it is appended, answering with the one recorded first", async () => {
      const log = await createEmptyLog();
      const message = userMessageNumbered(1);

      const first = await log.appendUserMessage("thread-a", message);
      const again = await log.appendUserMessage("thread-a", { ...message, text: "Edited" });
      const next = await log.appendUserMessage("thread-a", userMessageNumbered(2));

      expect(first.isAlreadyRecorded).toBe(false);
      expect(again).toEqual({ isAlreadyRecorded: true, recordedEvent: first.recordedEvent });
      expect(next.recordedEvent.sequence).toBe(2);
      expect(await readWholeThread(log, "thread-a")).toEqual([
        first.recordedEvent,
        next.recordedEvent,
      ]);
    });

    it("records one of a user message appended concurrently, and tells the others it was", async () => {
      const log = await createEmptyLog();

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => log.appendUserMessage("thread-a", userMessageNumbered(1))),
      );

      expect(outcomes.filter((outcome) => !outcome.isAlreadyRecorded)).toHaveLength(1);
      expect(new Set(outcomes.map((outcome) => outcome.recordedEvent.sequence))).toEqual(
        new Set([1]),
      );
      expect(await log.readNewestSequence("thread-a")).toBe(1);
    });

    it("tells apart user messages with the same identifier in different threads", async () => {
      const log = await createEmptyLog();

      await log.appendUserMessage("thread-a", userMessageNumbered(1));
      const otherThread = await log.appendUserMessage("thread-b", userMessageNumbered(1));

      expect(otherThread.isAlreadyRecorded).toBe(false);
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

      const recorded = await recordTestEvent(log, "thread-a", event);

      expect(await readWholeThread(log, "thread-a")).toEqual([recorded]);
      expect(recorded.event).toEqual(event);
    });

    it("reads only the events after the given sequence, in sequence order", async () => {
      const log = await createEmptyLog();
      await appendUserMessages(log, "thread-a", 5);

      const events = await log.readEvents("thread-a", {
        afterSequence: 2,
        throughSequence: 5,
        limit: 10,
      });

      expect(events.map((recorded) => recorded.sequence)).toEqual([3, 4, 5]);
      expect(events.map((recorded) => recorded.event)).toEqual([
        userMessageNumbered(3),
        userMessageNumbered(4),
        userMessageNumbered(5),
      ]);
    });

    it("reads no more events than the limit, starting with the first after the given sequence", async () => {
      const log = await createEmptyLog();
      await appendUserMessages(log, "thread-a", 6);

      const events = await log.readEvents("thread-a", {
        afterSequence: 1,
        throughSequence: 6,
        limit: 2,
      });

      expect(events.map((recorded) => recorded.sequence)).toEqual([2, 3]);
    });

    it("reads no event beyond the sequence it is told to read through", async () => {
      const log = await createEmptyLog();
      await appendUserMessages(log, "thread-a", 6);

      const events = await log.readEvents("thread-a", {
        afterSequence: 1,
        throughSequence: 4,
        limit: 10,
      });

      expect(events.map((recorded) => recorded.sequence)).toEqual([2, 3, 4]);
    });

    it("reads nothing after the newest sequence", async () => {
      const log = await createEmptyLog();
      await recordTestEvent(log, "thread-a", userMessageNumbered(1));

      for (const afterSequence of [1, 7]) {
        expect(
          await log.readEvents("thread-a", { afterSequence, throughSequence: 10, limit: 10 }),
        ).toEqual([]);
      }
    });

    it("reads nothing from a thread that has no events", async () => {
      const log = await createEmptyLog();
      await recordTestEvent(log, "thread-a", userMessageNumbered(1));

      expect(await readWholeThread(log, "thread-b")).toEqual([]);
    });

    it("reports the newest sequence of each thread, and 0 for a thread with no events", async () => {
      const log = await createEmptyLog();
      await appendUserMessages(log, "thread-a", 3);
      await appendUserMessages(log, "thread-b", 1);

      expect(await log.readNewestSequence("thread-a")).toBe(3);
      expect(await log.readNewestSequence("thread-b")).toBe(1);
      expect(await log.readNewestSequence("thread-c")).toBe(0);
    });
  });

  describe(`${implementationName} as a record of supervisor events`, () => {
    it("records a supervisor event once however many times it is appended", async () => {
      const log = await createEmptyLog();
      const origin = { supervisorInstanceId: "instance-1", eventNumber: 1 };

      const first = await log.appendSupervisorEvent("thread-a", toolStarted("call-1"), origin);
      const second = await log.appendSupervisorEvent("thread-a", toolStarted("call-1"), origin);
      const third = await log.appendSupervisorEvent("thread-a", toolStarted("call-1"), origin);

      expect(first).toMatchObject({ isAlreadyRecorded: false, recordedEvent: { sequence: 1 } });
      expect(second).toEqual({ isAlreadyRecorded: true });
      expect(third).toEqual({ isAlreadyRecorded: true });
      expect(await readWholeThread(log, "thread-a")).toHaveLength(1);
    });

    it("leaves no gap in the sequence when it refuses a duplicate", async () => {
      const log = await createEmptyLog();
      const origin = { supervisorInstanceId: "instance-1", eventNumber: 1 };
      await log.appendSupervisorEvent("thread-a", toolStarted("call-1"), origin);
      await log.appendSupervisorEvent("thread-a", toolStarted("call-1"), origin);

      const next = await recordTestEvent(log, "thread-a", userMessageNumbered(2));

      expect(next.sequence).toBe(2);
    });

    it("tells apart the same event number from two supervisor instances, and from two threads", async () => {
      const log = await createEmptyLog();

      const outcomes = [
        await log.appendSupervisorEvent("thread-a", toolStarted("call-1"), {
          supervisorInstanceId: "instance-1",
          eventNumber: 1,
        }),
        await log.appendSupervisorEvent("thread-a", toolStarted("call-2"), {
          supervisorInstanceId: "instance-2",
          eventNumber: 1,
        }),
        await log.appendSupervisorEvent("thread-b", toolStarted("call-3"), {
          supervisorInstanceId: "instance-1",
          eventNumber: 1,
        }),
      ];

      expect(outcomes.map((outcome) => outcome.isAlreadyRecorded)).toEqual([false, false, false]);
    });

    it("reports the last event number recorded from an instance, and 0 for an instance it never heard from", async () => {
      const log = await createEmptyLog();
      for (const eventNumber of [1, 2, 3]) {
        await log.appendSupervisorEvent("thread-a", toolStarted(`call-${eventNumber}`), {
          supervisorInstanceId: "instance-1",
          eventNumber,
        });
      }

      const known = await log.readSupervisorResumePoint("thread-a", "instance-1");
      const unknown = await log.readSupervisorResumePoint("thread-a", "instance-2");

      expect(known).toMatchObject({ newestSequence: 3, lastRecordedEventNumber: 3 });
      expect(unknown).toMatchObject({ newestSequence: 3, lastRecordedEventNumber: 0 });
    });

    it("reports a thread with no history as having nothing recorded, delivered or open", async () => {
      const log = await createEmptyLog();

      expect(await log.readSupervisorResumePoint("thread-a", "instance-1")).toEqual({
        newestSequence: 0,
        lastRecordedEventNumber: 0,
        userMessagesDeliveredThrough: 0,
        openRunSupervisorInstanceId: undefined,
      });
    });

    it("knows which instance started the open run, until a settled or failed run closes it", async () => {
      const log = await createEmptyLog();
      const openRun = async () =>
        (await log.readSupervisorResumePoint("thread-a", "instance-2")).openRunSupervisorInstanceId;
      const appendFromInstance = (event: AgentEvent, eventNumber: number) =>
        log.appendSupervisorEvent("thread-a", event, {
          supervisorInstanceId: "instance-1",
          eventNumber,
        });

      await appendFromInstance({ type: "agent_run_started" }, 1);
      const afterStart = await openRun();
      await appendFromInstance(toolStarted("call-1"), 2);
      await recordTestEvent(log, "thread-a", userMessageNumbered(3));
      const afterOtherEvents = await openRun();
      await appendFromInstance({ type: "agent_run_settled", wasInterrupted: false }, 3);
      const afterSettling = await openRun();
      await appendFromInstance({ type: "agent_run_started" }, 4);
      await log.closeOpenRun(
        "thread-a",
        { openedBySupervisorInstanceId: "instance-1" },
        { type: "agent_failed", errorMessage: "Gone" },
      );
      const afterFailing = await openRun();

      expect([afterStart, afterOtherEvents, afterSettling, afterFailing]).toEqual([
        "instance-1",
        "instance-1",
        undefined,
        undefined,
      ]);
    });

    it("keeps the furthest delivery of user messages it is told of, never moving back", async () => {
      const log = await createEmptyLog();
      await appendUserMessages(log, "thread-a", 5);

      await log.recordUserMessagesDelivered("thread-a", 3);
      await log.recordUserMessagesDelivered("thread-a", 2);
      const afterGoingBack = await log.readUserMessagesDeliveredThrough("thread-a");
      await log.recordUserMessagesDelivered("thread-a", 5);

      expect(afterGoingBack).toBe(3);
      expect(await log.readUserMessagesDeliveredThrough("thread-a")).toBe(5);
      expect(await log.readUserMessagesDeliveredThrough("thread-b")).toBe(0);
      expect(
        (await log.readSupervisorResumePoint("thread-a", "instance-1"))
          .userMessagesDeliveredThrough,
      ).toBe(5);
    });
  });

  describe(`${implementationName} closing a run nobody else can end`, () => {
    const gone: AgentFailedEvent = { type: "agent_failed", errorMessage: "Its sandbox stopped" };
    const openedByFirst = { openedBySupervisorInstanceId: "instance-1" };

    /** Opens a run with the instance's first event. */
    async function openRunFrom(log: ThreadEventLog, supervisorInstanceId: string): Promise<void> {
      await log.appendSupervisorEvent(
        "thread-a",
        { type: "agent_run_started" },
        { supervisorInstanceId, eventNumber: 1 },
      );
    }

    it("names the run open, by the instance that opened it, and nothing once it is closed", async () => {
      const log = await createEmptyLog();
      const beforeAnyRun = await log.readOpenRun("thread-a");
      await openRunFrom(log, "instance-1");
      const whileOpen = await log.readOpenRun("thread-a");
      await log.closeOpenRun("thread-a", openedByFirst, gone);

      expect(beforeAnyRun).toBeUndefined();
      expect(whileOpen).toEqual(openedByFirst);
      expect(await log.readOpenRun("thread-a")).toBeUndefined();
    });

    it("records the end once, however often it is asked, and nothing for a run already ended", async () => {
      const log = await createEmptyLog();
      await openRunFrom(log, "instance-1");

      const first = await log.closeOpenRun("thread-a", openedByFirst, gone);
      const again = await log.closeOpenRun("thread-a", openedByFirst, gone);

      expect(first).toMatchObject({ sequence: 2, event: gone });
      expect(again).toBeUndefined();
      expect(await readWholeThread(log, "thread-a")).toHaveLength(2);
      expect((await log.readAgentWork("thread-a")).hasOpenRun).toBe(false);
    });

    it("records one end when several ask at once", async () => {
      const log = await createEmptyLog();
      await openRunFrom(log, "instance-1");

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => log.closeOpenRun("thread-a", openedByFirst, gone)),
      );

      expect(outcomes.filter((outcome) => outcome !== undefined)).toHaveLength(1);
      expect(await log.readNewestSequence("thread-a")).toBe(2);
    });

    it("leaves alone a run opened since by another instance, and a thread with no run open", async () => {
      const log = await createEmptyLog();
      await openRunFrom(log, "instance-1");
      await log.appendSupervisorEvent(
        "thread-a",
        { type: "agent_run_settled", wasInterrupted: false },
        { supervisorInstanceId: "instance-1", eventNumber: 2 },
      );
      const withNoRunOpen = await log.closeOpenRun("thread-a", openedByFirst, gone);
      await openRunFrom(log, "instance-2");

      const withAnotherRunOpen = await log.closeOpenRun("thread-a", openedByFirst, gone);

      expect(withNoRunOpen).toBeUndefined();
      expect(withAnotherRunOpen).toBeUndefined();
      expect(await log.readOpenRun("thread-a")).toEqual({
        openedBySupervisorInstanceId: "instance-2",
      });
      expect(await log.readNewestSequence("thread-a")).toBe(3);
    });
  });

  describe(`${implementationName} as a record of the thread's repository`, () => {
    const published: RepositoryPublishedEvent = {
      type: "repository_published",
      workBranch: "barrack/thread-a",
      commit: "0123456789abcdef0123456789abcdef01234567",
      branchUrl: "https://github.com/octo/app/tree/barrack/thread-a",
      pullRequest: null,
      isPullRequestNew: false,
    };
    const failed: RepositoryPublicationFailedEvent = {
      type: "repository_publication_failed",
      errorMessage: "GitHub refused the push",
    };

    it("records a publication's outcome once however often it is appended, leaving no gap", async () => {
      const log = await createEmptyLog();

      const first = await log.appendPublicationOutcome("thread-a", published, "publication-1");
      const again = await log.appendPublicationOutcome("thread-a", published, "publication-1");
      const otherOutcome = await log.appendPublicationOutcome("thread-a", failed, "publication-1");
      const next = await recordTestEvent(log, "thread-a", userMessageNumbered(1));

      expect(first).toMatchObject({ isAlreadyRecorded: false, recordedEvent: { sequence: 1 } });
      expect(again).toEqual({ isAlreadyRecorded: true });
      expect(otherOutcome).toEqual({ isAlreadyRecorded: true });
      expect(next.sequence).toBe(2);
    });

    it("records one outcome of a publication appended concurrently", async () => {
      const log = await createEmptyLog();

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () =>
          log.appendPublicationOutcome("thread-a", published, "publication-1"),
        ),
      );

      expect(outcomes.filter((outcome) => !outcome.isAlreadyRecorded)).toHaveLength(1);
      expect(await log.readNewestSequence("thread-a")).toBe(1);
    });

    it("tells apart publications, and the same publication in different threads", async () => {
      const log = await createEmptyLog();

      await log.appendPublicationOutcome("thread-a", published, "publication-1");
      const second = await log.appendPublicationOutcome("thread-a", published, "publication-2");
      const otherThread = await log.appendPublicationOutcome("thread-b", failed, "publication-1");

      expect(second.isAlreadyRecorded).toBe(false);
      expect(otherThread.isAlreadyRecorded).toBe(false);
    });

    it("leaves the open run alone while recording the clone's events and publications", async () => {
      const log = await createEmptyLog();
      const instance = "instance-1";
      await log.appendSupervisorEvent(
        "thread-a",
        {
          type: "repository_clone_started",
          repositoryUrl: "https://github.com/octo/app",
          baseBranch: null,
        },
        { supervisorInstanceId: instance, eventNumber: 1 },
      );
      const beforeAnyRun = await log.readOpenRun("thread-a");
      await log.appendSupervisorEvent(
        "thread-a",
        { type: "agent_run_started" },
        { supervisorInstanceId: instance, eventNumber: 2 },
      );
      await log.appendSupervisorEvent(
        "thread-a",
        { type: "repository_clone_failed", errorMessage: "The repository went away" },
        { supervisorInstanceId: instance, eventNumber: 3 },
      );
      await log.appendPublicationOutcome("thread-a", failed, "publication-1");

      expect(beforeAnyRun).toBeUndefined();
      expect(await log.readOpenRun("thread-a")).toEqual({ openedBySupervisorInstanceId: instance });
      expect(
        (await log.readSupervisorResumePoint("thread-a", instance)).lastRecordedEventNumber,
      ).toBe(3);
    });
  });

  describe(`${implementationName} as a record of the agent's work`, () => {
    it("reports a thread with no history as having no open run and nothing to deliver", async () => {
      const log = await createEmptyLog();

      expect(await log.readAgentWork("thread-a")).toEqual({
        hasOpenRun: false,
        hasUndeliveredUserMessage: false,
      });
    });

    it("reports a user message as waiting until delivery reaches it, whatever comes after it", async () => {
      const log = await createEmptyLog();
      await appendUserMessages(log, "thread-a", 2);
      await recordTestEvent(log, "thread-a", toolStarted("call-1"));

      const beforeDelivery = await log.readAgentWork("thread-a");
      await log.recordUserMessagesDelivered("thread-a", 1);
      const afterDeliveringTheFirst = await log.readAgentWork("thread-a");
      await log.recordUserMessagesDelivered("thread-a", 2);

      expect(beforeDelivery.hasUndeliveredUserMessage).toBe(true);
      expect(afterDeliveringTheFirst.hasUndeliveredUserMessage).toBe(true);
      expect((await log.readAgentWork("thread-a")).hasUndeliveredUserMessage).toBe(false);
    });

    it("reports a run as open from its start until it ends, and finds the threads with one", async () => {
      const log = await createEmptyLog();
      const origin = (eventNumber: number) => ({ supervisorInstanceId: "instance-1", eventNumber });
      await log.appendSupervisorEvent("thread-a", { type: "agent_run_started" }, origin(1));
      await log.appendSupervisorEvent("thread-b", { type: "agent_run_started" }, origin(1));
      await log.appendSupervisorEvent(
        "thread-b",
        { type: "agent_run_settled", wasInterrupted: false },
        origin(2),
      );

      expect((await log.readAgentWork("thread-a")).hasOpenRun).toBe(true);
      expect((await log.readAgentWork("thread-b")).hasOpenRun).toBe(false);
      expect(await log.findThreadsWithOpenRuns(["thread-a", "thread-b", "thread-c"])).toEqual(
        new Set(["thread-a"]),
      );
      expect(await log.findThreadsWithOpenRuns([])).toEqual(new Set());
    });

    it("deletes a thread's whole history and nothing of another's, so it starts again from sequence 1", async () => {
      const log = await createEmptyLog();
      await appendUserMessages(log, "thread-a", 3);
      await appendUserMessages(log, "thread-b", 2);

      await log.deleteHistory("thread-a");
      await log.deleteHistory("thread-that-never-was");

      expect(await log.readNewestSequence("thread-a")).toBe(0);
      expect(await readWholeThread(log, "thread-a")).toEqual([]);
      expect(await log.readAgentWork("thread-a")).toEqual({
        hasOpenRun: false,
        hasUndeliveredUserMessage: false,
      });
      expect(await log.readNewestSequence("thread-b")).toBe(2);
      expect((await recordTestEvent(log, "thread-a", userMessageNumbered(1))).sequence).toBe(1);
    });
  });
}

function toolStarted(toolCallId: string): AgentEvent {
  return { type: "tool_execution_started", toolCallId, toolName: "bash", arguments: {} };
}

async function appendUserMessages(
  log: ThreadEventLog,
  threadId: string,
  count: number,
): Promise<void> {
  for (let number = 1; number <= count; number += 1) {
    await recordTestEvent(log, threadId, userMessageNumbered(number));
  }
}

function userMessageNumbered(number: number): UserMessageEvent {
  return { type: "user_message", messageId: `message-${number}`, text: `Message ${number}` };
}
