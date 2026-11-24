import type { ControlPlaneToClientMessage, ThreadEvent } from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentRunSettled,
  agentRunStarted,
  completedAssistantMessage,
  toolExecutionStarted,
} from "../test-support/example-agent-events.js";
import { TestControlPlane } from "../test-support/test-control-plane.js";
import type { FakeSupervisor, TestClient } from "../test-support/test-peers.js";

const threadId = "thread-1";

let controlPlane: TestControlPlane;

beforeEach(async () => {
  controlPlane = await TestControlPlane.start();
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

function isSupervisorStatus(isSupervisorConnected: boolean) {
  return (message: ControlPlaneToClientMessage) =>
    message.type === "supervisor_connection_status" &&
    message.isSupervisorConnected === isSupervisorConnected;
}

describe("a client connecting to a thread", () => {
  it("is announced an empty replay and then told the supervisor status when the thread has no history", async () => {
    const client = await controlPlane.connectClient(threadId);

    await client.inbox.waitUntil("two messages arrived", (messages) => messages.length === 2);

    expect(client.inbox.messages).toEqual([
      { type: "replay_announcement", firstSequence: 1, lastSequence: 0 },
      { type: "supervisor_connection_status", isSupervisorConnected: false },
    ]);
  });

  it("is announced the range it missed, then sent exactly those events, then the supervisor status", async () => {
    const supervisor = await controlPlane.connectSupervisor(threadId);
    const observer = await controlPlane.connectClient(threadId);
    await recordAgentEvents(supervisor, observer, 1, 5);

    const client = await controlPlane.connectClient(threadId, 2);
    await client.inbox.waitFor("the supervisor status", isSupervisorStatus(true));

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
    ]);
    expect(sequencesOf(client)).toEqual([3, 4, 5]);
  });

  it("is sent events recorded during its replay exactly once and in sequence order", async () => {
    const supervisor = await controlPlane.connectSupervisor(threadId);
    const observer = await controlPlane.connectClient(threadId);
    await recordAgentEvents(supervisor, observer, 1, 5);
    const readGates = controlPlane.threadEventLog.holdNextRead();

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

  it("receives live events after its replay without a gap", async () => {
    const supervisor = await controlPlane.connectSupervisor(threadId);
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

    const supervisor = await controlPlane.connectSupervisor(threadId);
    await client.inbox.waitFor("told the supervisor connected", isSupervisorStatus(true));
    await supervisor.close();
    await client.inbox.waitUntil(
      "told the supervisor disconnected",
      (messages) => messages.filter(isSupervisorStatus(false)).length === 2,
    );

    expect(messageTypesOf(client)).toEqual([
      "replay_announcement",
      "supervisor_connection_status",
      "supervisor_connection_status",
      "supervisor_connection_status",
    ]);
  });

  it("is replayed the whole thread when it claims to have seen more than the log holds", async () => {
    const supervisor = await controlPlane.connectSupervisor(threadId);
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
});

describe("agent events from the supervisor", () => {
  it("are recorded with consecutive sequences and shown to every client in the order they were sent", async () => {
    const supervisor = await controlPlane.connectSupervisor(threadId);
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
    expect(await controlPlane.threadEventLog.readAfter(threadId, 0)).toEqual(
      firstClient.threadEvents,
    );
  });

  it("are not shown to clients until they have been recorded", async () => {
    const supervisor = await controlPlane.connectSupervisor(threadId);
    const client = await controlPlane.connectClient(threadId);
    await client.inbox.waitFor("the supervisor status", isSupervisorStatus(true));
    const appendGate = controlPlane.threadEventLog.holdNextAppend();

    supervisor.sendAgentEvent(agentRunStarted);
    await appendGate.reached;
    const typesWhileRecording = messageTypesOf(client);
    appendGate.release();
    await client.waitForSequence(1);

    expect(typesWhileRecording).not.toContain("thread_event");
  });
});

describe("stream fragments from the supervisor", () => {
  it("are relayed to clients and never recorded", async () => {
    const supervisor = await controlPlane.connectSupervisor(threadId);
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
    expect(await controlPlane.threadEventLog.readAfter(threadId, 0)).toEqual([]);
  });

  it("reach a client that joins mid-message as the text so far, after its replay", async () => {
    const supervisor = await controlPlane.connectSupervisor(threadId);
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
      "stream_fragment",
      "stream_fragment",
    ]);
    expect(joiner.inbox.messages.slice(3)).toEqual([
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

  it("are no longer sent to joining clients once the completed message is recorded", async () => {
    const supervisor = await controlPlane.connectSupervisor(threadId);
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
    await joiner.inbox.waitFor("the supervisor status", isSupervisorStatus(true));

    expect(messageTypesOf(joiner)).toEqual([
      "replay_announcement",
      "thread_event",
      "supervisor_connection_status",
    ]);
  });
});

describe("user messages from a client", () => {
  it("are recorded, shown to clients, and only then delivered to the supervisor", async () => {
    const supervisor = await controlPlane.connectSupervisor(threadId);
    const client = await controlPlane.connectClient(threadId);
    await client.inbox.waitFor("the supervisor status", isSupervisorStatus(true));
    const appendGate = controlPlane.threadEventLog.holdNextAppend();

    client.sendUserMessage("Please say hello");
    await appendGate.reached;
    const deliveriesWhileRecording = supervisor.inbox.messages.length;
    appendGate.release();
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
      messageId: recordedEvent?.type === "user_message" ? recordedEvent.messageId : undefined,
      text: "Please say hello",
    });
  });

  it("are rejected and not recorded when no supervisor is connected", async () => {
    const client = await controlPlane.connectClient(threadId);

    client.sendUserMessage("Is anyone there?");
    const rejection = await client.inbox.waitFor(
      "a rejection",
      (message) => message.type === "client_message_rejected",
    );

    expect(rejection).toEqual({
      type: "client_message_rejected",
      reason: expect.stringContaining("No agent is connected"),
    });
    expect(await controlPlane.threadEventLog.readAfter(threadId, 0)).toEqual([]);
  });
});

describe("interrupts from a client", () => {
  it("are forwarded to the supervisor", async () => {
    const supervisor = await controlPlane.connectSupervisor(threadId);
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
});
