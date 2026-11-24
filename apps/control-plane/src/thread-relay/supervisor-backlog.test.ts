import type { AgentEvent, AssistantTextFragment } from "@barrack/protocol";
import { maximumAgentEventFrameLength } from "@barrack/protocol";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { standardCloseCodes } from "../standard-close-codes.js";
import { acceptingThreadActivity } from "../test-support/accepting-thread-activity.js";
import { ControllableThreadEventLog } from "../test-support/controllable-thread-event-log.js";
import { completedAssistantMessage } from "../test-support/example-agent-events.js";
import {
  allPendingWorkSettled,
  attachGreetedSupervisor,
  FakeClientConnection,
  FakeSupervisorConnection,
} from "../test-support/fake-connections.js";
import { readWholeThread } from "../test-support/read-whole-thread.js";
import {
  streamFragmentsBacklogLimit,
  supervisorMessagesBacklogLimit,
} from "./supervisor-backlog.js";
import { ThreadRelay } from "./thread-relay.js";

/*
 * What a thread's supervisors send waits in its relay's queue while an
 * append is under way. These tests hold an append, as a slow database
 * would, and check that what may wait is bounded.
 */

function createRelay(threadEventLog: ControllableThreadEventLog, threadId: string): ThreadRelay {
  return new ThreadRelay({
    threadId,
    threadEventLog,
    threadActivity: acceptingThreadActivity,
    logger: pino({ level: "silent" }),
    whenUnused: () => undefined,
  });
}

/** An assistant message whose frame is close to the largest a supervisor may send. */
const largeText = "x".repeat(maximumAgentEventFrameLength - 1_000);

function largeAssistantMessage(index: number): AgentEvent {
  return completedAssistantMessage(`assistant-${index}`, largeText);
}

function textFragment(messageId: string, appendedText: string): AssistantTextFragment {
  return {
    type: "assistant_text_fragment",
    messageId,
    contentBlockIndex: 0,
    contentBlockType: "text",
    appendedText,
  };
}

async function recordedEventNumbers(
  threadEventLog: ControllableThreadEventLog,
  threadId: string,
): Promise<string[]> {
  const recordedEvents = await readWholeThread(threadEventLog, threadId);
  return recordedEvents.map(({ event }) =>
    event.type === "assistant_message" ? event.messageId : event.type,
  );
}

describe("what a supervisor sends while its thread's events are being recorded", () => {
  it("is bounded: a supervisor that sends more is disconnected, and everything it sent before is still recorded", async () => {
    const threadEventLog = new ControllableThreadEventLog();
    const relay = createRelay(threadEventLog, "thread-1");
    const supervisor = new FakeSupervisorConnection();
    attachGreetedSupervisor(relay, supervisor);
    await allPendingWorkSettled();
    const appendGates = threadEventLog.holdNextAppend();

    const frameLength = JSON.stringify({
      type: "agent_event",
      eventNumber: 10,
      event: largeAssistantMessage(10),
    }).length;
    const framesThatFit = Math.floor(supervisorMessagesBacklogLimit / frameLength);
    for (let index = 1; index <= framesThatFit + 5; index += 1) {
      relay.receiveFromSupervisor(supervisor, supervisor.numbered(largeAssistantMessage(index)));
    }
    const closingWhileHeld = supervisor.closingRequest;
    appendGates.beforeRecording.release();
    appendGates.afterRecording.release();
    await allPendingWorkSettled();

    expect(closingWhileHeld?.closeCode).toBe(standardCloseCodes.tryAgainLater);
    const recorded = await recordedEventNumbers(threadEventLog, "thread-1");
    expect(recorded).toEqual(
      Array.from({ length: framesThatFit }, (_unused, offset) => `assistant-${offset + 1}`),
    );
  });

  it("loses nothing: the supervisor's events are recorded in order once it reconnects and sends them again", async () => {
    const threadEventLog = new ControllableThreadEventLog();
    const relay = createRelay(threadEventLog, "thread-1");
    const supervisor = new FakeSupervisorConnection("instance-1");
    attachGreetedSupervisor(relay, supervisor);
    await allPendingWorkSettled();
    const appendGates = threadEventLog.holdNextAppend();
    const events = Array.from({ length: 12 }, (_unused, offset) =>
      largeAssistantMessage(offset + 1),
    );
    for (const event of events) {
      relay.receiveFromSupervisor(supervisor, supervisor.numbered(event));
    }
    appendGates.beforeRecording.release();
    appendGates.afterRecording.release();
    await allPendingWorkSettled();
    relay.detachSupervisor(supervisor);

    const reconnected = new FakeSupervisorConnection("instance-1");
    attachGreetedSupervisor(relay, reconnected);
    await allPendingWorkSettled();
    const welcome = reconnected.inbox.messages.find(
      (message) => message.type === "supervisor_welcome",
    );
    const lastRecordedEventNumber =
      welcome?.type === "supervisor_welcome" ? welcome.lastRecordedEventNumber : 0;
    events.forEach((event, offset) => {
      const eventNumber = offset + 1;
      if (eventNumber > lastRecordedEventNumber) {
        relay.receiveFromSupervisor(reconnected, { type: "agent_event", eventNumber, event });
      }
    });
    await allPendingWorkSettled();

    expect(supervisor.closingRequest?.closeCode).toBe(standardCloseCodes.tryAgainLater);
    expect(await recordedEventNumbers(threadEventLog, "thread-1")).toEqual(
      events.map((_event, offset) => `assistant-${offset + 1}`),
    );
  });

  it("drops stream fragments past their own budget, with the rest of that message's, and keeps the supervisor", async () => {
    const threadEventLog = new ControllableThreadEventLog();
    const relay = createRelay(threadEventLog, "thread-1");
    const supervisor = new FakeSupervisorConnection();
    const client = new FakeClientConnection();
    attachGreetedSupervisor(relay, supervisor);
    relay.attachClient(client, 0);
    await allPendingWorkSettled();
    const appendGates = threadEventLog.holdNextAppend();
    relay.receiveFromSupervisor(
      supervisor,
      supervisor.numbered(completedAssistantMessage("earlier", "Hello")),
    );

    const fragmentText = "y".repeat(64 * 1024);
    const fragmentFrameLength = JSON.stringify({
      type: "stream_fragment",
      fragment: textFragment("streaming", fragmentText),
    }).length;
    const fragmentsThatFit = Math.floor(streamFragmentsBacklogLimit / fragmentFrameLength);
    for (let index = 0; index < fragmentsThatFit + 3; index += 1) {
      relay.receiveFromSupervisor(supervisor, {
        type: "stream_fragment",
        fragment: textFragment("streaming", fragmentText),
      });
    }
    appendGates.beforeRecording.release();
    appendGates.afterRecording.release();
    await allPendingWorkSettled();
    relay.receiveFromSupervisor(supervisor, {
      type: "stream_fragment",
      fragment: textFragment("streaming", "after the backlog cleared"),
    });
    relay.receiveFromSupervisor(supervisor, {
      type: "stream_fragment",
      fragment: textFragment("next", "a new message streams again"),
    });
    await allPendingWorkSettled();

    const relayedTexts = client.inbox.messages.flatMap((message) =>
      message.type === "stream_fragment"
        ? [`${message.fragment.messageId}:${message.fragment.appendedText.length}`]
        : [],
    );
    expect(supervisor.closingRequest).toBeUndefined();
    expect(relayedTexts).toEqual([
      ...Array.from({ length: fragmentsThatFit }, () => `streaming:${fragmentText.length}`),
      `next:${"a new message streams again".length}`,
    ]);
  });

  it("does not hold up another thread's events", async () => {
    const threadEventLog = new ControllableThreadEventLog();
    const floodedRelay = createRelay(threadEventLog, "flooded-thread");
    const quietRelay = createRelay(threadEventLog, "quiet-thread");
    const flooding = new FakeSupervisorConnection();
    const quiet = new FakeSupervisorConnection();
    const quietWatcher = new FakeClientConnection();
    attachGreetedSupervisor(floodedRelay, flooding);
    attachGreetedSupervisor(quietRelay, quiet);
    quietRelay.attachClient(quietWatcher, 0);
    await allPendingWorkSettled();
    const appendGates = threadEventLog.holdNextAppend();

    for (let index = 1; index <= 20; index += 1) {
      floodedRelay.receiveFromSupervisor(flooding, flooding.numbered(largeAssistantMessage(index)));
    }
    await appendGates.beforeRecording.reached;
    quietRelay.receiveFromSupervisor(
      quiet,
      quiet.numbered(completedAssistantMessage("quiet-1", "Still here")),
    );
    await allPendingWorkSettled();
    const quietThreadEvents = quietWatcher.inbox.messages.filter(
      (message) => message.type === "thread_event",
    );
    appendGates.beforeRecording.release();
    appendGates.afterRecording.release();
    await allPendingWorkSettled();

    expect(quietThreadEvents).toHaveLength(1);
    expect(flooding.closingRequest?.closeCode).toBe(standardCloseCodes.tryAgainLater);
  });
});

describe("supervisor connections to one thread", () => {
  it("are refused past a few open at once, since each can hold a frame being received", async () => {
    const relay = createRelay(new ControllableThreadEventLog(), "thread-1");
    const connections = Array.from({ length: 5 }, () => new FakeSupervisorConnection());

    for (const connection of connections) {
      relay.attachSupervisor(connection);
    }
    relay.detachSupervisor(connections[0] as FakeSupervisorConnection);
    const afterOneClosed = new FakeSupervisorConnection();
    relay.attachSupervisor(afterOneClosed);

    expect(connections.map((connection) => connection.closingRequest?.closeCode)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      standardCloseCodes.tryAgainLater,
    ]);
    expect(afterOneClosed.closingRequest).toBeUndefined();
  });
});
