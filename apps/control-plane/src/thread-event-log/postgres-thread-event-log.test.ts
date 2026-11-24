import { type ThreadEvent, type ToolArguments, threadEventSchema } from "@barrack/protocol";
import { escapeIdentifier, type Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agentRunStarted, toolExecutionStarted } from "../test-support/example-agent-events.js";
import {
  attachGreetedSupervisor,
  FakeClientConnection,
  FakeSupervisorConnection,
} from "../test-support/fake-connections.js";
import { readWholeThread } from "../test-support/read-whole-thread.js";
import {
  createTestPool,
  describeWithTestDatabase,
  silentLogger,
  TestSchemas,
} from "../test-support/test-database.js";
import { describeThreadEventLogContract } from "../test-support/thread-event-log-contract.js";
import { readMissedEvents } from "../thread-relay/read-missed-events.js";
import { ThreadRelay } from "../thread-relay/thread-relay.js";
import { PostgresThreadEventLog } from "./postgres-thread-event-log.js";

const threadId = "thread-1";

function userMessage(messageId: string): ThreadEvent {
  return { type: "user_message", messageId, text: `Message ${messageId}` };
}

function oneToN(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

describeWithTestDatabase("the Postgres thread event log", () => {
  let pool: Pool;
  let schemas: TestSchemas;

  beforeAll(() => {
    pool = createTestPool();
    schemas = new TestSchemas(pool);
  });

  afterAll(async () => {
    await schemas.dropAll();
    await pool.end();
  });

  async function createEmptyLog(): Promise<PostgresThreadEventLog> {
    return new PostgresThreadEventLog(pool, await schemas.createMigrated());
  }

  describeThreadEventLogContract("PostgresThreadEventLog", createEmptyLog);

  it("gives appends racing from two control planes to one thread gapless sequences, with none lost and recorded times in order", async () => {
    const schema = await schemas.createMigrated();
    const otherControlPlanePool = createTestPool();
    try {
      const firstLog = new PostgresThreadEventLog(pool, schema);
      const secondLog = new PostgresThreadEventLog(otherControlPlanePool, schema);
      const messageIds = Array.from({ length: 500 }, (_, index) => `message-${index}`);

      const recorded = await Promise.all(
        messageIds.map((messageId, index) =>
          (index % 2 === 0 ? firstLog : secondLog).append(threadId, userMessage(messageId)),
        ),
      );
      const stored = await readWholeThread(firstLog, threadId);

      const bySequence = (first: { sequence: number }, second: { sequence: number }) =>
        first.sequence - second.sequence;
      expect(recorded.toSorted(bySequence).map((event) => event.sequence)).toEqual(
        oneToN(messageIds.length),
      );
      expect(stored.map((event) => event.sequence)).toEqual(oneToN(messageIds.length));
      expect(stored).toEqual(recorded.toSorted(bySequence));
      const storedMessageIds = stored.map((event) =>
        event.event.type === "user_message" ? event.event.messageId : undefined,
      );
      expect(new Set(storedMessageIds)).toEqual(new Set(messageIds));
      const recordedTimes = stored.map((event) => Date.parse(event.recordedAt));
      expect(recordedTimes).toEqual(recordedTimes.toSorted((a, b) => a - b));
    } finally {
      await otherControlPlanePool.end();
    }
  });

  it("records each supervisor event once when two control planes race to append the same events", async () => {
    const schema = await schemas.createMigrated();
    const otherControlPlanePool = createTestPool();
    try {
      const firstLog = new PostgresThreadEventLog(pool, schema);
      const secondLog = new PostgresThreadEventLog(otherControlPlanePool, schema);
      const eventNumbers = oneToN(100);

      // Every event is appended by both control planes at once, as when a
      // supervisor resends to a new instance what an old one is still
      // recording; a user message is mixed in to show the sequence stays whole.
      const outcomes = await Promise.all(
        eventNumbers.flatMap((eventNumber) =>
          [firstLog, secondLog].map((log) =>
            log.appendSupervisorEvent(threadId, toolExecutionStarted(`call-${eventNumber}`), {
              supervisorInstanceId: "instance-1",
              eventNumber,
            }),
          ),
        ),
      );
      const followingMessage = await firstLog.append(threadId, userMessage("after-the-race"));
      const stored = await readWholeThread(firstLog, threadId);

      const recordedCount = outcomes.filter((outcome) => !outcome.isAlreadyRecorded).length;
      expect(recordedCount).toBe(eventNumbers.length);
      expect(stored.map((event) => event.sequence)).toEqual(oneToN(eventNumbers.length + 1));
      const storedToolCalls = stored.flatMap((event) =>
        event.event.type === "tool_execution_started" ? [event.event.toolCallId] : [],
      );
      expect(storedToolCalls.toSorted()).toEqual(
        eventNumbers.map((eventNumber) => `call-${eventNumber}`).toSorted(),
      );
      expect(followingMessage.sequence).toBe(eventNumbers.length + 1);
    } finally {
      await otherControlPlanePool.end();
    }
  });

  it("lets appends to one thread go ahead while an append to another waits for that thread's lock", async () => {
    const schema = await schemas.createMigrated();
    const log = new PostgresThreadEventLog(pool, schema);
    await log.append("thread-a", userMessage("a-1"));
    await log.append("thread-b", userMessage("b-1"));
    const lockHolder = await pool.connect();
    try {
      await lockHolder.query("begin");
      await lockHolder.query(
        `select 1 from ${escapeIdentifier(schema)}.thread_sequence_counters where thread_id = 'thread-a' for update`,
      );

      const appendingToThreadA = log.append("thread-a", userMessage("a-2"));
      await vi.waitFor(() => expectAnAppendWaitingForALock(schema), { timeout: 5_000 });
      const appendedToThreadB = await log.append("thread-b", userMessage("b-2"));
      await lockHolder.query("commit");

      expect(appendedToThreadB.sequence).toBe(2);
      expect((await appendingToThreadA).sequence).toBe(2);
    } finally {
      lockHolder.release();
    }
  });

  async function expectAnAppendWaitingForALock(schema: string): Promise<void> {
    const waiting = await pool.query(
      `select count(*)::integer as count from pg_stat_activity
       where wait_event_type = 'Lock' and query like '%' || $1 || '.thread_sequence_counters%'`,
      [escapeIdentifier(schema)],
    );
    expect(waiting.rows[0]?.count).toBe(1);
  }

  it("returns every kind of thread event exactly as it was appended, character for character", async () => {
    const log = await createEmptyLog();
    const events = eventsOfEveryKindWithAwkwardContent();
    for (const event of events) {
      expect(threadEventSchema.safeParse(event).success).toBe(true);
    }
    expect(new Set(events.map((event) => event.type)).size).toBe(threadEventSchema.options.length);

    for (const event of events) {
      await log.append(threadId, event);
    }
    const stored = await readWholeThread(log, threadId);

    expect(stored.map((recordedEvent) => JSON.stringify(recordedEvent.event))).toEqual(
      events.map((event) => JSON.stringify(event)),
    );
  });

  it("reads exactly the range up to the newest sequence it reported while appends continue", async () => {
    const log = await createEmptyLog();
    const appenderCount = 3;
    const appendsPerAppender = 150;
    let isAppending = true;
    const appending = Promise.all(
      Array.from({ length: appenderCount }, async (_, appenderIndex) => {
        for (let index = 0; index < appendsPerAppender; index += 1) {
          await log.append(threadId, userMessage(`appender-${appenderIndex}-${index}`));
        }
      }),
    ).finally(() => {
      isAppending = false;
    });

    let readsWhileAppending = 0;
    while (isAppending) {
      const newestSequence = await log.readNewestSequence(threadId);
      const sequences = [];
      for await (const recordedEvent of readMissedEvents(log, threadId, {
        afterSequence: 0,
        lastSequence: newestSequence,
      })) {
        sequences.push(recordedEvent.sequence);
      }
      expect(sequences).toEqual(oneToN(newestSequence));
      readsWhileAppending += 1;
    }
    await appending;

    expect(readsWhileAppending).toBeGreaterThan(1);
    expect(await log.readNewestSequence(threadId)).toBe(appenderCount * appendsPerAppender);
  });

  it("lets a client joining while events are being recorded see each exactly once, in order, after the announced range", async () => {
    const log = await createEmptyLog();
    const relay = new ThreadRelay({
      threadId,
      threadEventLog: log,
      logger: silentLogger,
      whenUnused: () => undefined,
    });
    const supervisor = new FakeSupervisorConnection();
    attachGreetedSupervisor(relay, supervisor);
    const eventCount = 1_500;
    for (let index = 1; index <= eventCount; index += 1) {
      relay.receiveFromSupervisor(
        supervisor,
        supervisor.numbered(index === 1 ? agentRunStarted : toolExecutionStarted(`call-${index}`)),
      );
    }
    await vi.waitFor(
      async () => expect(await log.readNewestSequence(threadId)).toBeGreaterThan(50),
      {
        timeout: 10_000,
      },
    );

    const client = new FakeClientConnection();
    relay.attachClient(client, 0);
    const threadEventSequences = () =>
      client.inbox.messages.flatMap((message) =>
        message.type === "thread_event" ? [message.sequence] : [],
      );
    await vi.waitFor(() => expect(threadEventSequences().at(-1)).toBe(eventCount), {
      timeout: 20_000,
    });

    const announcement = client.inbox.messages[0];
    expect(announcement?.type).toBe("replay_announcement");
    const lastAnnounced =
      announcement?.type === "replay_announcement" ? announcement.lastSequence : 0;
    expect(lastAnnounced).toBeGreaterThan(50);
    expect(lastAnnounced).toBeLessThan(eventCount);
    expect(
      client.inbox.messages.slice(1, lastAnnounced + 1).map((message) => message.type),
    ).toEqual(Array.from({ length: lastAnnounced }, () => "thread_event"));
    expect(threadEventSequences()).toEqual(oneToN(eventCount));
  });
});

/**
 * One event of every kind, between them holding text that databases and
 * encoders tend to mangle: U+0000, an unpaired surrogate, a right-to-left
 * override, combining marks, characters outside the Basic Multilingual
 * Plane, escapes, and tool arguments nested 200 deep.
 */
function eventsOfEveryKindWithAwkwardContent(): ThreadEvent[] {
  const awkwardText =
    'nul:\u0000 lone:\ud800 rtl:‮abc combining:é astral:𝔘🧑‍💻 cjk:日本語 quote:" backslash:\\ newline:\n tab:\t';
  let nestedArguments: ToolArguments = { leaf: awkwardText };
  for (let depth = 0; depth < 200; depth += 1) {
    nestedArguments = { [`level ${depth} ✓`]: [nestedArguments, depth, null, true, 1.5e300] };
  }
  return [
    { type: "user_message", messageId: "message-1", text: awkwardText },
    { type: "agent_run_started" },
    {
      type: "assistant_message",
      messageId: "assistant-1",
      content: [
        { type: "thinking", text: awkwardText },
        { type: "text", text: awkwardText },
        {
          type: "tool_call",
          toolCallId: "call-1",
          toolName: "bash",
          arguments: { nested: nestedArguments },
        },
      ],
      endReason: "tool_use_requested",
    },
    {
      type: "tool_execution_started",
      toolCallId: "call-1",
      toolName: "bash",
      arguments: { nested: nestedArguments },
    },
    {
      type: "tool_execution_finished",
      toolCallId: "call-1",
      toolName: "bash",
      isError: false,
      output: {
        text: awkwardText.repeat(Math.floor((64 * 1024) / awkwardText.length)),
        isTruncated: true,
        originalSizeInBytes: 1_000_000,
      },
      durationInMilliseconds: 1234,
    },
    {
      type: "assistant_message",
      messageId: "assistant-2",
      content: [],
      endReason: "errored",
      errorMessage: awkwardText,
    },
    { type: "agent_run_settled", wasInterrupted: true },
    { type: "agent_failed", errorMessage: awkwardText },
  ];
}
