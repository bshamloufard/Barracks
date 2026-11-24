import type { AgentEvent, ControlPlaneToClientMessage, ThreadEvent } from "@barrack/protocol";
import { closeCodes, maximumFrameLength, measureLargestThreadEventFrame } from "@barrack/protocol";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { standardCloseCodes } from "../standard-close-codes.js";
import { acceptingThreadActivity } from "../test-support/accepting-thread-activity.js";
import { ControllableThreadEventLog } from "../test-support/controllable-thread-event-log.js";
import {
  agentRunSettled,
  agentRunStarted,
  completedAssistantMessage,
  toolExecutionStarted,
} from "../test-support/example-agent-events.js";
import {
  allPendingWorkSettled,
  attachGreetedSupervisor,
  FakeClientConnection,
  FakeSupervisorConnection,
} from "../test-support/fake-connections.js";
import { readWholeThread } from "../test-support/read-whole-thread.js";
import { recordTestEvent } from "../test-support/record-test-events.js";
import { TestControlPlane, type TestThread } from "../test-support/test-control-plane.js";
import type { FakeSupervisor, TestClient } from "../test-support/test-peers.js";
import { replayPageSize } from "./read-missed-events.js";
import { ThreadRelay } from "./thread-relay.js";

/*
 * Most of these tests drive a real control plane over WebSockets. Those that
 * need several messages to be waiting in the relay's queue at once drive a
 * relay directly through fake connections instead, because a real socket
 * cannot promise when its frames reach the relay.
 */

let controlPlane: TestControlPlane;
let thread: TestThread;
let threadId: string;

beforeEach(async () => {
  controlPlane = await TestControlPlane.start();
  thread = await controlPlane.createThread();
  threadId = thread.threadId;
});

afterEach(async () => {
  await controlPlane.close();
});

/** Records `count` agent events through the supervisor and waits until a live client has them. */
async function recordAgentEvents(
  supervisor: FakeSupervisor,
  observer: TestClient,
  firstSequence: number,
  count: number,
): Promise<void> {
  for (let offset = 0; offset < count; offset += 1) {
    supervisor.sendAgentEvent(toolExecutionStarted(`call-${firstSequence + offset}`));
  }
  await observer.waitForSequence(firstSequence + count - 1);
}

function sequencesOf(client: TestClient): number[] {
  return client.threadEvents.map((recordedEvent) => recordedEvent.sequence);
}

function messageTypesOf(client: TestClient): string[] {
  return client.inbox.messages.map((message) => message.type);
}

function createRelayWithControllableLog(): {
  relay: ThreadRelay;
  threadEventLog: ControllableThreadEventLog;
} {
  const threadEventLog = new ControllableThreadEventLog();
  const relay = new ThreadRelay({
    threadId,
    threadEventLog,
    threadActivity: acceptingThreadActivity,
    logger: pino({ level: "silent" }),
    whenUnused: () => undefined,
  });
  return { relay, threadEventLog };
}

function sendAgentEvent(
  relay: ThreadRelay,
  supervisor: FakeSupervisorConnection,
  event: AgentEvent,
): void {
  relay.receiveFromSupervisor(supervisor, supervisor.numbered(event));
}

async function recordedEventTypes(threadEventLog: ControllableThreadEventLog): Promise<string[]> {
  const recordedEvents = await readWholeThread(threadEventLog, threadId);
  return recordedEvents.map((recordedEvent) => recordedEvent.event.type);
}

function isDeliveryStatus(message: ControlPlaneToClientMessage): boolean {
  return message.type === "user_message_delivery_status";
}

function isSupervisorStatus(isSupervisorConnected: boolean) {
  return (message: ControlPlaneToClientMessage) =>
    message.type === "supervisor_connection_status" &&
    message.isSupervisorConnected === isSupervisorConnected;
}

describe("a client connecting to a thread", () => {
  it("is announced an empty replay and then told the supervisor and delivery statuses when the thread has no history", async () => {
    const client = await controlPlane.connectClient(threadId);

    await client.inbox.waitUntil("three messages arrived", (messages) => messages.length === 3);

    expect(client.inbox.messages).toEqual([
      { type: "replay_announcement", firstSequence: 1, lastSequence: 0 },
      { type: "supervisor_connection_status", isSupervisorConnected: false },
      { type: "user_message_delivery_status", deliveredThroughSequence: 0 },
    ]);
  });

  it("is announced the range it missed, then sent exactly those events, then the statuses", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const observer = await controlPlane.connectClient(threadId);
    await recordAgentEvents(supervisor, observer, 1, 5);

    const client = await controlPlane.connectClient(threadId, 2);
    await client.inbox.waitFor("the delivery status", isDeliveryStatus);

    expect(client.inbox.messages[0]).toEqual({
      type: "replay_announcement",
      firstSequence: 3,
      lastSequence: 5,
    });
    expect(messageTypesOf(client)).toEqual([
      "replay_announcement",
      "thread_event",
      "thread_event",
      "thread_event",
      "supervisor_connection_status",
      "user_message_delivery_status",
    ]);
    expect(sequencesOf(client)).toEqual([3, 4, 5]);
  });

  it("is sent events recorded during its replay exactly once and in sequence order", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const observer = await controlPlane.connectClient(threadId);
    await recordAgentEvents(supervisor, observer, 1, 5);
    const readGates = controlPlane.threadEventLog.holdNextNewestSequenceRead();

    const connecting = controlPlane.connectClient(threadId, 2);
    // Recorded after the client subscribed but before the log is read: these
    // reach the client both in the replay and as live events.
    await readGates.beforeReading.reached;
    await recordAgentEvents(supervisor, observer, 6, 3);
    readGates.beforeReading.release();
    // Recorded after the log was read: these reach the client only as live events.
    await readGates.afterReading.reached;
    await recordAgentEvents(supervisor, observer, 9, 2);
    readGates.afterReading.release();
    const client = await connecting;
    await client.waitForSequence(10);

    expect(client.inbox.messages[0]).toEqual({
      type: "replay_announcement",
      firstSequence: 3,
      lastSequence: 8,
    });
    expect(sequencesOf(client)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("is sent the supervisor status and streamed text as they are when its replay ends, not as they changed during it", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const observer = await controlPlane.connectClient(threadId);
    await recordAgentEvents(supervisor, observer, 1, 2);
    const readGates = controlPlane.threadEventLog.holdNextNewestSequenceRead();

    const connecting = controlPlane.connectClient(threadId);
    await readGates.beforeReading.reached;
    for (const appendedText of ["Hel", "lo"]) {
      supervisor.sendTextFragment({
        messageId: "assistant-1",
        contentBlockIndex: 0,
        contentBlockType: "text",
        appendedText,
      });
    }
    await supervisor.close();
    await observer.inbox.waitFor("told the supervisor disconnected", isSupervisorStatus(false));
    readGates.beforeReading.release();
    readGates.afterReading.release();
    const client = await connecting;
    await client.inbox.waitFor("a fragment", (message) => message.type === "stream_fragment");

    expect(client.inbox.messages.slice(3)).toEqual([
      { type: "supervisor_connection_status", isSupervisorConnected: false },
      { type: "user_message_delivery_status", deliveredThroughSequence: 0 },
      {
        type: "stream_fragment",
        fragment: {
          type: "assistant_text_fragment",
          messageId: "assistant-1",
          contentBlockIndex: 0,
          contentBlockType: "text",
          appendedText: "Hello",
        },
      },
    ]);
  });

  it("is sent nothing more once it detaches in the middle of its replay", async () => {
    const { relay, threadEventLog } = createRelayWithControllableLog();
    const supervisor = new FakeSupervisorConnection();
    attachGreetedSupervisor(relay, supervisor);
    sendAgentEvent(relay, supervisor, agentRunStarted);
    await allPendingWorkSettled();
    const readGates = threadEventLog.holdNextNewestSequenceRead();
    const client = new FakeClientConnection();

    relay.attachClient(client, 0);
    await readGates.beforeReading.reached;
    relay.detachClient(client);
    sendAgentEvent(relay, supervisor, toolExecutionStarted("call-1"));
    await allPendingWorkSettled();
    readGates.beforeReading.release();
    readGates.afterReading.release();
    await allPendingWorkSettled();

    expect(client.inbox.messages).toEqual([]);
  });

  it("is detached and disconnected when its history cannot be read", async () => {
    const { relay, threadEventLog } = createRelayWithControllableLog();
    const client = new FakeClientConnection();
    threadEventLog.failNextRead(new Error("The log is unavailable"));

    relay.attachClient(client, 0);
    await allPendingWorkSettled();
    relay.receiveFromClient(client, { type: "interrupt_agent" });
    await allPendingWorkSettled();

    expect(client.closingRequest?.closeCode).toBe(standardCloseCodes.internalError);
    expect(client.inbox.messages.map((message) => message.type)).toEqual([
      "client_message_rejected",
    ]);
  });

  it("receives live events after its replay without a gap", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const observer = await controlPlane.connectClient(threadId);
    await recordAgentEvents(supervisor, observer, 1, 2);
    const client = await controlPlane.connectClient(threadId, 1);
    await client.inbox.waitFor("the supervisor status", isSupervisorStatus(true));

    await recordAgentEvents(supervisor, observer, 3, 2);
    await client.waitForSequence(4);

    expect(sequencesOf(client)).toEqual([2, 3, 4]);
  });

  it("is told whenever the supervisor connects or disconnects", async () => {
    const client = await controlPlane.connectClient(threadId);
    await client.inbox.waitFor("told no supervisor is connected", isSupervisorStatus(false));

    const supervisor = await controlPlane.connectSupervisor(thread);
    await client.inbox.waitFor("told the supervisor connected", isSupervisorStatus(true));
    await supervisor.close();
    await client.inbox.waitUntil(
      "told the supervisor disconnected",
      (messages) => messages.filter(isSupervisorStatus(false)).length === 2,
    );

    expect(messageTypesOf(client)).toEqual([
      "replay_announcement",
      "supervisor_connection_status",
      "user_message_delivery_status",
      "supervisor_connection_status",
      "supervisor_connection_status",
    ]);
  });

  it("is replayed the whole thread when it claims to have seen more than the log holds", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const observer = await controlPlane.connectClient(threadId);
    await recordAgentEvents(supervisor, observer, 1, 2);

    const client = await controlPlane.connectClient(threadId, 7);
    await client.waitForSequence(2);

    expect(client.inbox.messages[0]).toEqual({
      type: "replay_announcement",
      firstSequence: 1,
      lastSequence: 2,
    });
    expect(sequencesOf(client)).toEqual([1, 2]);
  });

  it("is replayed a history longer than one page of the log in full and in order", async () => {
    const { relay, threadEventLog } = createRelayWithControllableLog();
    const eventCount = replayPageSize * 2 + 7;
    for (let index = 1; index <= eventCount; index += 1) {
      await recordTestEvent(threadEventLog, threadId, toolExecutionStarted(`call-${index}`));
    }
    const client = new FakeClientConnection();

    relay.attachClient(client, 0);
    await allPendingWorkSettled();

    expect(client.inbox.messages[0]).toEqual({
      type: "replay_announcement",
      firstSequence: 1,
      lastSequence: eventCount,
    });
    expect(
      client.inbox.messages.flatMap((message) =>
        message.type === "thread_event" ? [message.sequence] : [],
      ),
    ).toEqual(Array.from({ length: eventCount }, (_, index) => index + 1));
  });

  it("is sent an event once when the log acknowledges recording it only after the client has replayed it", async () => {
    const { relay, threadEventLog } = createRelayWithControllableLog();
    const supervisor = new FakeSupervisorConnection();
    attachGreetedSupervisor(relay, supervisor);
    sendAgentEvent(relay, supervisor, agentRunStarted);
    await allPendingWorkSettled();
    const appendGates = threadEventLog.holdNextAppend();
    appendGates.beforeRecording.release();
    sendAgentEvent(relay, supervisor, toolExecutionStarted("call-1"));
    await appendGates.afterRecording.reached;

    const client = new FakeClientConnection();
    relay.attachClient(client, 0);
    await allPendingWorkSettled();
    appendGates.afterRecording.release();
    sendAgentEvent(relay, supervisor, agentRunSettled);
    await allPendingWorkSettled();

    expect(
      client.inbox.messages.flatMap((message) =>
        message.type === "thread_event" ? [message.sequence] : [],
      ),
    ).toEqual([1, 2, 3]);
  });
});

describe("a live client", () => {
  it("is disconnected, rather than shown a gap, when an event was recorded that this relay never broadcast", async () => {
    const { relay, threadEventLog } = createRelayWithControllableLog();
    const supervisor = new FakeSupervisorConnection();
    const client = new FakeClientConnection();
    attachGreetedSupervisor(relay, supervisor);
    relay.attachClient(client, 0);
    sendAgentEvent(relay, supervisor, agentRunStarted);
    await allPendingWorkSettled();

    // As another control plane instance appending to the same thread would.
    await recordTestEvent(threadEventLog, threadId, toolExecutionStarted("call-from-elsewhere"));
    sendAgentEvent(relay, supervisor, agentRunSettled);
    await allPendingWorkSettled();

    expect(
      client.inbox.messages.flatMap((message) =>
        message.type === "thread_event" ? [message.sequence] : [],
      ),
    ).toEqual([1]);
    expect(client.closingRequest?.closeCode).toBe(standardCloseCodes.internalError);
  });
});

describe("agent events from the supervisor", () => {
  it("are recorded with consecutive sequences and shown to every client in the order they were sent", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const firstClient = await controlPlane.connectClient(threadId);
    const secondClient = await controlPlane.connectClient(threadId);
    const events = [
      agentRunStarted,
      completedAssistantMessage("assistant-1", "Hello"),
      toolExecutionStarted("call-1"),
      agentRunSettled,
    ];

    for (const event of events) {
      supervisor.sendAgentEvent(event);
    }
    await firstClient.waitForSequence(4);
    await secondClient.waitForSequence(4);

    for (const client of [firstClient, secondClient]) {
      expect(client.threadEvents.map((recordedEvent) => recordedEvent.event)).toEqual(events);
      expect(sequencesOf(client)).toEqual([1, 2, 3, 4]);
    }
    expect(await readWholeThread(controlPlane.threadEventLog, threadId)).toEqual(
      firstClient.threadEvents,
    );
  });

  it("are not shown to clients until they have been recorded", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const client = await controlPlane.connectClient(threadId);
    await client.inbox.waitFor("the supervisor status", isSupervisorStatus(true));
    const appendGates = controlPlane.threadEventLog.holdNextAppend();

    supervisor.sendAgentEvent(agentRunStarted);
    await appendGates.beforeRecording.reached;
    const typesWhileRecording = messageTypesOf(client);
    appendGates.beforeRecording.release();
    appendGates.afterRecording.release();
    await client.waitForSequence(1);

    expect(typesWhileRecording).not.toContain("thread_event");
  });

  it("stop being recorded from a supervisor once one of its events could not be", async () => {
    const { relay, threadEventLog } = createRelayWithControllableLog();
    const supervisor = new FakeSupervisorConnection();
    attachGreetedSupervisor(relay, supervisor);
    sendAgentEvent(relay, supervisor, agentRunStarted);
    await allPendingWorkSettled();

    threadEventLog.failNextAppend(new Error("The log is unavailable"));
    sendAgentEvent(relay, supervisor, completedAssistantMessage("assistant-1", "Hello"));
    sendAgentEvent(relay, supervisor, agentRunSettled);
    await allPendingWorkSettled();

    expect(await recordedEventTypes(threadEventLog)).toEqual(["agent_run_started"]);
    expect(supervisor.closingRequest?.closeCode).toBe(standardCloseCodes.internalError);
  });

  it("leave clients told the supervisor is gone once one of its events could not be recorded", async () => {
    const { relay, threadEventLog } = createRelayWithControllableLog();
    const supervisor = new FakeSupervisorConnection();
    const client = new FakeClientConnection();
    attachGreetedSupervisor(relay, supervisor);
    relay.attachClient(client, 0);
    await allPendingWorkSettled();

    threadEventLog.failNextAppend(new Error("The log is unavailable"));
    sendAgentEvent(relay, supervisor, agentRunStarted);
    await allPendingWorkSettled();

    expect(client.inbox.messages.at(-1)).toEqual({
      type: "supervisor_connection_status",
      isSupervisorConnected: false,
    });
  });

  it("are recorded up to the largest whose client frame fits, and one character more is refused", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const client = await controlPlane.connectClient(threadId);
    const emptyMessage = completedAssistantMessage("assistant-1", "");
    const roomForText = maximumFrameLength - measureLargestThreadEventFrame(emptyMessage);
    const largestMessage = completedAssistantMessage("assistant-1", "x".repeat(roomForText));
    const oversizedMessage = completedAssistantMessage("assistant-2", "x".repeat(roomForText + 1));

    supervisor.sendAgentEvent(largestMessage);
    await client.waitForSequence(1);
    supervisor.sendAgentEvent(oversizedMessage);
    const supervisorClosing = await supervisor.closed;

    expect(client.threadEvents.map((recordedEvent) => recordedEvent.event)).toEqual([
      largestMessage,
    ]);
    expect(supervisorClosing.closeCode).toBe(closeCodes.invalidMessage);
    expect(await recordedEventTypes(controlPlane.threadEventLog)).toEqual(["assistant_message"]);
  });

  it("are ignored from a supervisor that a newer one has superseded", async () => {
    const { relay, threadEventLog } = createRelayWithControllableLog();
    const supersededSupervisor = new FakeSupervisorConnection();
    const newerSupervisor = new FakeSupervisorConnection();
    attachGreetedSupervisor(relay, supersededSupervisor);

    attachGreetedSupervisor(relay, newerSupervisor);
    sendAgentEvent(relay, supersededSupervisor, toolExecutionStarted("call-from-superseded"));
    sendAgentEvent(relay, newerSupervisor, agentRunStarted);
    await allPendingWorkSettled();

    expect(await recordedEventTypes(threadEventLog)).toEqual(["agent_run_started"]);
    expect(supersededSupervisor.closingRequest?.closeCode).toBe(
      closeCodes.supersededByNewerSupervisor,
    );
    expect(newerSupervisor.closingRequest).toBeUndefined();
  });
});

describe("stream fragments from the supervisor", () => {
  it("are relayed to clients and never recorded", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const client = await controlPlane.connectClient(threadId);
    const fragment = {
      messageId: "assistant-1",
      contentBlockIndex: 0,
      contentBlockType: "text",
      appendedText: "Hel",
    } as const;

    supervisor.sendTextFragment(fragment);
    const relayed = await client.inbox.waitFor(
      "a fragment",
      (message) => message.type === "stream_fragment",
    );

    expect(relayed).toEqual({
      type: "stream_fragment",
      fragment: { type: "assistant_text_fragment", ...fragment },
    });
    expect(await readWholeThread(controlPlane.threadEventLog, threadId)).toEqual([]);
  });

  it("reach a client that joins mid-message as the text so far, after its replay", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const observer = await controlPlane.connectClient(threadId);
    supervisor.sendAgentEvent(agentRunStarted);
    supervisor.sendTextFragment({
      messageId: "assistant-1",
      contentBlockIndex: 0,
      contentBlockType: "thinking",
      appendedText: "Let me ",
    });
    supervisor.sendTextFragment({
      messageId: "assistant-1",
      contentBlockIndex: 0,
      contentBlockType: "thinking",
      appendedText: "think.",
    });
    supervisor.sendTextFragment({
      messageId: "assistant-1",
      contentBlockIndex: 1,
      contentBlockType: "text",
      appendedText: "Hello, ",
    });
    supervisor.sendTextFragment({
      messageId: "assistant-1",
      contentBlockIndex: 1,
      contentBlockType: "text",
      appendedText: "wor",
    });
    await observer.inbox.waitUntil(
      "four fragments arrived",
      (messages) => messages.filter((message) => message.type === "stream_fragment").length === 4,
    );

    const joiner = await controlPlane.connectClient(threadId);
    await joiner.inbox.waitUntil(
      "two fragments arrived",
      (messages) => messages.filter((message) => message.type === "stream_fragment").length === 2,
    );

    expect(messageTypesOf(joiner)).toEqual([
      "replay_announcement",
      "thread_event",
      "supervisor_connection_status",
      "user_message_delivery_status",
      "stream_fragment",
      "stream_fragment",
    ]);
    expect(joiner.inbox.messages.slice(4)).toEqual([
      {
        type: "stream_fragment",
        fragment: {
          type: "assistant_text_fragment",
          messageId: "assistant-1",
          contentBlockIndex: 0,
          contentBlockType: "thinking",
          appendedText: "Let me think.",
        },
      },
      {
        type: "stream_fragment",
        fragment: {
          type: "assistant_text_fragment",
          messageId: "assistant-1",
          contentBlockIndex: 1,
          contentBlockType: "text",
          appendedText: "Hello, wor",
        },
      },
    ]);
  });

  it.each<[string, AgentEvent]>([
    ["the run settles", agentRunSettled],
    ["the agent fails", { type: "agent_failed", errorMessage: "Pi exited with code 1" }],
  ])(
    "of a message never completed are no longer sent to joining clients once %s",
    async (_, runEnd) => {
      const supervisor = await controlPlane.connectSupervisor(thread);
      const observer = await controlPlane.connectClient(threadId);
      supervisor.sendAgentEvent(agentRunStarted);
      supervisor.sendTextFragment({
        messageId: "assistant-1",
        contentBlockIndex: 0,
        contentBlockType: "text",
        appendedText: "Half a sen",
      });
      supervisor.sendAgentEvent(runEnd);
      await observer.waitForSequence(2);

      const joiner = await controlPlane.connectClient(threadId);
      await joiner.inbox.waitFor("the delivery status", isDeliveryStatus);

      expect(messageTypesOf(joiner)).toEqual([
        "replay_announcement",
        "thread_event",
        "thread_event",
        "supervisor_connection_status",
        "user_message_delivery_status",
      ]);
    },
  );

  it("are no longer sent to joining clients once the completed message is recorded", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const observer = await controlPlane.connectClient(threadId);
    supervisor.sendTextFragment({
      messageId: "assistant-1",
      contentBlockIndex: 0,
      contentBlockType: "text",
      appendedText: "Hello",
    });
    supervisor.sendAgentEvent(completedAssistantMessage("assistant-1", "Hello"));
    await observer.waitForSequence(1);

    const joiner = await controlPlane.connectClient(threadId);
    await joiner.inbox.waitFor("the delivery status", isDeliveryStatus);

    expect(messageTypesOf(joiner)).toEqual([
      "replay_announcement",
      "thread_event",
      "supervisor_connection_status",
      "user_message_delivery_status",
    ]);
  });
});

describe("user messages from a client", () => {
  it("are recorded, shown to clients, and only then delivered to the supervisor", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const client = await controlPlane.connectClient(threadId);
    await client.inbox.waitFor("the supervisor status", isSupervisorStatus(true));
    const appendGates = controlPlane.threadEventLog.holdNextAppend();

    client.sendUserMessage("Please say hello");
    await appendGates.beforeRecording.reached;
    const deliveriesWhileRecording = supervisor.deliveredUserMessages.length;
    appendGates.beforeRecording.release();
    appendGates.afterRecording.release();
    const delivery = await supervisor.inbox.waitFor(
      "a delivered user message",
      (message) => message.type === "deliver_user_message",
    );
    await client.waitForSequence(1);

    expect(deliveriesWhileRecording).toBe(0);
    const recordedEvent: ThreadEvent | undefined = client.threadEvents[0]?.event;
    expect(recordedEvent).toEqual({
      type: "user_message",
      messageId: expect.any(String),
      text: "Please say hello",
    });
    expect(delivery).toEqual({
      type: "deliver_user_message",
      sequence: 1,
      messageId: recordedEvent?.type === "user_message" ? recordedEvent.messageId : undefined,
      text: "Please say hello",
    });
  });
});

describe("a user message sent again", () => {
  it("is recorded and handed to the agent once, when the first attempt was saved but reported as not", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const client = await controlPlane.connectClient(threadId);
    await client.inbox.waitFor("the supervisor status", isSupervisorStatus(true));
    controlPlane.threadEventLog.failNextAppendAfterRecording(
      new Error("The database's answer was lost"),
    );

    const messageId = client.sendUserMessage("Please say hello");
    const rejection = await client.inbox.waitFor(
      "the rejection",
      (message) => message.type === "client_message_rejected",
    );
    client.sendUserMessage("Please say hello", messageId);
    await client.waitForSequence(1);
    await supervisor.inbox.waitFor(
      "the delivery",
      (message) => message.type === "deliver_user_message",
    );
    client.sendUserMessage("And once more", messageId);
    const second = client.sendUserMessage("A new message");
    await client.waitForSequence(2);
    await supervisor.inbox.waitUntil("both deliveries", () =>
      supervisor.deliveredUserMessages.some((delivery) => delivery.sequence === 2),
    );

    expect(rejection).toEqual({
      type: "client_message_rejected",
      reason: expect.stringContaining("could not be saved"),
      messageId,
    });
    expect(client.threadEvents.map(({ event }) => event)).toEqual([
      { type: "user_message", messageId, text: "Please say hello" },
      { type: "user_message", messageId: second, text: "A new message" },
    ]);
    expect(
      supervisor.deliveredUserMessages.map((delivery) => [delivery.sequence, delivery.messageId]),
    ).toEqual([
      [1, messageId],
      [2, second],
    ]);
  });
});

describe("interrupts from a client", () => {
  it("are forwarded to the supervisor", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    const client = await controlPlane.connectClient(threadId);

    client.interruptAgent();

    expect(
      await supervisor.inbox.waitFor(
        "an interrupt",
        (message) => message.type === "interrupt_agent",
      ),
    ).toEqual({ type: "interrupt_agent" });
  });

  it("are rejected when no supervisor is connected", async () => {
    const client = await controlPlane.connectClient(threadId);

    client.interruptAgent();

    expect(
      await client.inbox.waitFor(
        "a rejection",
        (message) => message.type === "client_message_rejected",
      ),
    ).toEqual({
      type: "client_message_rejected",
      reason: expect.stringContaining("nothing to interrupt"),
    });
  });

  it("are rejected when the supervisor's connection is closing", async () => {
    const { relay } = createRelayWithControllableLog();
    const supervisor = new FakeSupervisorConnection();
    const client = new FakeClientConnection();
    attachGreetedSupervisor(relay, supervisor);
    relay.attachClient(client, 0);
    await allPendingWorkSettled();
    supervisor.isAcceptingMessages = false;

    relay.receiveFromClient(client, { type: "interrupt_agent" });
    await allPendingWorkSettled();

    expect(client.inbox.messages.at(-1)).toEqual({
      type: "client_message_rejected",
      reason: expect.stringContaining("could not be delivered to the agent"),
    });
  });
});
