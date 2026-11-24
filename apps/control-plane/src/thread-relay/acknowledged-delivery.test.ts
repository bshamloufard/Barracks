import { closeCodes, type ThreadEvent } from "@barrack/protocol";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { standardCloseCodes } from "../standard-close-codes.js";
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
import { TestControlPlane, type TestThread } from "../test-support/test-control-plane.js";
import type { FakeSupervisor } from "../test-support/test-peers.js";
import { abandonedRunErrorMessage, ThreadRelay } from "./thread-relay.js";

/*
 * The guarantees of acknowledged delivery between a supervisor and the
 * control plane (see packages/protocol/src/supervisor-messages.ts). Tests
 * that need to control exactly when the log answers drive a relay directly
 * through fake connections; the rest use a real control plane.
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

function createRelay(): { relay: ThreadRelay; threadEventLog: ControllableThreadEventLog } {
  const threadEventLog = new ControllableThreadEventLog();
  const relay = new ThreadRelay({
    threadId,
    threadEventLog,
    logger: pino({ level: "silent" }),
    whenUnused: () => undefined,
  });
  return { relay, threadEventLog };
}

async function recordedEvents(
  threadEventLog = controlPlane.threadEventLog,
): Promise<ThreadEvent[]> {
  return (await readWholeThread(threadEventLog, threadId)).map((recorded) => recorded.event);
}

function acknowledgedEventNumbers(supervisor: FakeSupervisorConnection): number[] {
  return supervisor.inbox.messages.flatMap((message) =>
    message.type === "agent_events_recorded" ? [message.throughEventNumber] : [],
  );
}

function welcomeOf(supervisor: FakeSupervisor): unknown {
  return supervisor.inbox.messages.find((message) => message.type === "supervisor_welcome");
}

function deliveredTexts(supervisor: FakeSupervisor): string[] {
  return supervisor.deliveredUserMessages.map((message) => message.text);
}

describe("agent events from a supervisor", () => {
  it("are acknowledged only once they are recorded", async () => {
    const { relay, threadEventLog } = createRelay();
    const supervisor = new FakeSupervisorConnection();
    attachGreetedSupervisor(relay, supervisor);
    await allPendingWorkSettled();
    const appendGates = threadEventLog.holdNextAppend();

    relay.receiveFromSupervisor(supervisor, supervisor.numbered(agentRunStarted));
    await appendGates.beforeRecording.reached;
    const acknowledgedBeforeRecording = acknowledgedEventNumbers(supervisor);
    appendGates.beforeRecording.release();
    await appendGates.afterRecording.reached;
    const acknowledgedBeforeTheLogAnswered = acknowledgedEventNumbers(supervisor);
    appendGates.afterRecording.release();
    await allPendingWorkSettled();

    expect(acknowledgedBeforeRecording).toEqual([]);
    expect(acknowledgedBeforeTheLogAnswered).toEqual([]);
    expect(acknowledgedEventNumbers(supervisor)).toEqual([1]);
  });

  it("are recorded once when the same supervisor sends them again after reconnecting", async () => {
    const firstConnection = await controlPlane.connectSupervisor(thread);
    firstConnection.sendAgentEvent(agentRunStarted);
    firstConnection.sendAgentEvent(toolExecutionStarted("call-1"));
    await firstConnection.waitUntilRecorded(2);
    await firstConnection.close();

    const reconnection = await controlPlane.connectSupervisor(thread, {
      supervisorInstanceId: firstConnection.supervisorInstanceId,
    });
    // It never saw the acknowledgements, so it sends everything again.
    reconnection.sendAgentEventNumbered(1, agentRunStarted);
    reconnection.sendAgentEventNumbered(2, toolExecutionStarted("call-1"));
    reconnection.sendAgentEventNumbered(3, agentRunSettled);
    await reconnection.waitUntilRecorded(3);

    expect(welcomeOf(reconnection)).toEqual({
      type: "supervisor_welcome",
      lastRecordedEventNumber: 2,
    });
    expect(await recordedEvents()).toEqual([
      agentRunStarted,
      toolExecutionStarted("call-1"),
      agentRunSettled,
    ]);
  });

  it("are recorded exactly once after an append that failed is sent again", async () => {
    const { relay, threadEventLog } = createRelay();
    const instanceId = "supervisor-instance-1";
    const firstConnection = new FakeSupervisorConnection(instanceId);
    attachGreetedSupervisor(relay, firstConnection);
    relay.receiveFromSupervisor(firstConnection, firstConnection.numbered(agentRunStarted));
    await allPendingWorkSettled();

    threadEventLog.failNextAppend(new Error("The database is unavailable"));
    const lostMessage = firstConnection.numbered(completedAssistantMessage("assistant-1", "Hi"));
    const following = firstConnection.numbered(agentRunSettled);
    relay.receiveFromSupervisor(firstConnection, lostMessage);
    relay.receiveFromSupervisor(firstConnection, following);
    await allPendingWorkSettled();
    const recordedBeforeReconnecting = await recordedEvents(threadEventLog);
    relay.detachSupervisor(firstConnection);
    const reconnection = new FakeSupervisorConnection(instanceId);
    attachGreetedSupervisor(relay, reconnection);
    relay.receiveFromSupervisor(reconnection, lostMessage);
    relay.receiveFromSupervisor(reconnection, following);
    await allPendingWorkSettled();

    expect(firstConnection.closingRequest?.closeCode).toBe(standardCloseCodes.internalError);
    expect(recordedBeforeReconnecting).toEqual([agentRunStarted]);
    expect(reconnection.inbox.messages[0]).toEqual({
      type: "supervisor_welcome",
      lastRecordedEventNumber: 1,
    });
    expect(await recordedEvents(threadEventLog)).toEqual([
      agentRunStarted,
      completedAssistantMessage("assistant-1", "Hi"),
      agentRunSettled,
    ]);
    expect(acknowledgedEventNumbers(reconnection)).toEqual([2, 3]);
  });

  it("are recorded exactly once when an append reported as failed had in fact been recorded", async () => {
    const { relay, threadEventLog } = createRelay();
    const instanceId = "supervisor-instance-1";
    const firstConnection = new FakeSupervisorConnection(instanceId);
    attachGreetedSupervisor(relay, firstConnection);
    await allPendingWorkSettled();

    threadEventLog.failNextAppendAfterRecording(new Error("The connection dropped after commit"));
    const event = firstConnection.numbered(agentRunStarted);
    relay.receiveFromSupervisor(firstConnection, event);
    await allPendingWorkSettled();
    relay.detachSupervisor(firstConnection);
    const reconnection = new FakeSupervisorConnection(instanceId);
    attachGreetedSupervisor(relay, reconnection);
    relay.receiveFromSupervisor(reconnection, event);
    await allPendingWorkSettled();

    expect(await recordedEvents(threadEventLog)).toEqual([agentRunStarted]);
    expect(reconnection.inbox.messages).toEqual([
      { type: "supervisor_welcome", lastRecordedEventNumber: 1 },
      { type: "agent_events_recorded", throughEventNumber: 1 },
    ]);
  });

  it("are recorded once when two connections of one supervisor send the same event", async () => {
    const { relay, threadEventLog } = createRelay();
    const olderConnection = new FakeSupervisorConnection("supervisor-instance-1");
    const newerConnection = new FakeSupervisorConnection("supervisor-instance-1");
    const appendGates = threadEventLog.holdNextAppend();
    attachGreetedSupervisor(relay, olderConnection);
    relay.receiveFromSupervisor(olderConnection, olderConnection.numbered(agentRunStarted));
    await appendGates.beforeRecording.reached;

    // The newer connection's hello waits in the relay's queue behind the
    // append, as it would behind a slow database.
    attachGreetedSupervisor(relay, newerConnection);
    relay.receiveFromSupervisor(newerConnection, newerConnection.numbered(agentRunStarted));
    appendGates.beforeRecording.release();
    appendGates.afterRecording.release();
    await allPendingWorkSettled();

    expect(await recordedEvents(threadEventLog)).toEqual([agentRunStarted]);
    expect(olderConnection.closingRequest?.closeCode).toBe(closeCodes.supersededByNewerSupervisor);
    expect(acknowledgedEventNumbers(newerConnection)).toEqual([1]);
  });
});

describe("user messages sent while no supervisor is connected", () => {
  it("are recorded, shown as waiting, and delivered in order exactly once when a supervisor attaches", async () => {
    const client = await controlPlane.connectClient(threadId);
    client.sendUserMessage("First");
    client.sendUserMessage("Second");
    await client.waitForSequence(2);

    const supervisor = await controlPlane.connectSupervisor(thread);
    await supervisor.inbox.waitUntil(
      "both messages are delivered",
      () => supervisor.deliveredUserMessages.length === 2,
    );
    supervisor.acknowledgeUserMessages(2);
    await client.inbox.waitFor(
      "the messages are reported delivered",
      (message) =>
        message.type === "user_message_delivery_status" && message.deliveredThroughSequence === 2,
    );
    client.sendUserMessage("Third");
    await supervisor.inbox.waitUntil(
      "the third message is delivered",
      () => supervisor.deliveredUserMessages.length === 3,
    );

    expect(client.inbox.messages.map((message) => message.type).slice(0, 5)).toEqual([
      "replay_announcement",
      "supervisor_connection_status",
      "user_message_delivery_status",
      "thread_event",
      "thread_event",
    ]);
    expect(client.inbox.messages[2]).toEqual({
      type: "user_message_delivery_status",
      deliveredThroughSequence: 0,
    });
    expect(supervisor.deliveredUserMessages.map((message) => message.sequence)).toEqual([1, 2, 3]);
    expect(deliveredTexts(supervisor)).toEqual(["First", "Second", "Third"]);
  });

  it("are never refused for want of an agent", async () => {
    const client = await controlPlane.connectClient(threadId);

    client.sendUserMessage("Anyone there?");
    await client.waitForSequence(1);

    expect(client.inbox.messages.map((message) => message.type)).not.toContain(
      "client_message_rejected",
    );
  });
});

describe("user messages the supervisor never acknowledged", () => {
  it("are delivered again when its connection dies with the message in flight", async () => {
    const firstConnection = await controlPlane.connectSupervisor(thread);
    const client = await controlPlane.connectClient(threadId);
    client.sendUserMessage("Did you get this?");
    await firstConnection.inbox.waitUntil(
      "the message is sent",
      () => firstConnection.deliveredUserMessages.length === 1,
    );
    await firstConnection.close();

    const reconnection = await controlPlane.connectSupervisor(thread, {
      supervisorInstanceId: firstConnection.supervisorInstanceId,
    });
    await reconnection.inbox.waitUntil(
      "the message is sent again",
      () => reconnection.deliveredUserMessages.length === 1,
    );

    expect(reconnection.deliveredUserMessages).toEqual(firstConnection.deliveredUserMessages);
  });

  it("are not sent again to a supervisor that says it already handed them to the agent", async () => {
    const firstConnection = await controlPlane.connectSupervisor(thread);
    const client = await controlPlane.connectClient(threadId);
    client.sendUserMessage("Handed over, but the acknowledgement was lost");
    await firstConnection.inbox.waitUntil(
      "the message is sent",
      () => firstConnection.deliveredUserMessages.length === 1,
    );
    await firstConnection.close();

    const restarted = await controlPlane.connectSupervisor(thread, {
      userMessagesDeliveredThroughSequence: 1,
    });
    client.sendUserMessage("A new message");
    await restarted.inbox.waitUntil(
      "the new message is sent",
      () => restarted.deliveredUserMessages.length === 1,
    );

    expect(deliveredTexts(restarted)).toEqual(["A new message"]);
  });

  it("are not handed to a supervisor starting afresh once an earlier one acknowledged them", async () => {
    const firstSupervisor = await controlPlane.connectSupervisor(thread);
    const client = await controlPlane.connectClient(threadId);
    client.sendUserMessage("Already answered");
    await firstSupervisor.inbox.waitUntil(
      "the message is sent",
      () => firstSupervisor.deliveredUserMessages.length === 1,
    );
    firstSupervisor.acknowledgeUserMessages(1);
    await client.inbox.waitFor(
      "the message is reported delivered",
      (message) =>
        message.type === "user_message_delivery_status" && message.deliveredThroughSequence === 1,
    );
    await firstSupervisor.close();

    const freshSupervisor = await controlPlane.connectSupervisor(thread);
    client.sendUserMessage("New");
    await freshSupervisor.inbox.waitUntil(
      "the new message is sent",
      () => freshSupervisor.deliveredUserMessages.length === 1,
    );

    expect(deliveredTexts(freshSupervisor)).toEqual(["New"]);
  });

  it("are handed over in order when another control plane recorded one this relay never saw", async () => {
    const { relay, threadEventLog } = createRelay();
    const supervisor = new FakeSupervisorConnection();
    const client = new FakeClientConnection();
    attachGreetedSupervisor(relay, supervisor);
    relay.attachClient(client, 0);
    await allPendingWorkSettled();

    await threadEventLog.append(threadId, {
      type: "user_message",
      messageId: "recorded-elsewhere",
      text: "From another instance",
    });
    relay.receiveFromClient(client, { type: "send_user_message", text: "From this one" });
    await allPendingWorkSettled();

    expect(
      supervisor.inbox.messages.flatMap((message) =>
        message.type === "deliver_user_message" ? [[message.sequence, message.text]] : [],
      ),
    ).toEqual([
      [1, "From another instance"],
      [2, "From this one"],
    ]);
  });
});

describe("a supervisor attaching to a thread with a run open", () => {
  it("closes the run as failed, for every client to see, when an earlier supervisor started it", async () => {
    const crashedSupervisor = await controlPlane.connectSupervisor(thread);
    crashedSupervisor.sendAgentEvent(agentRunStarted);
    crashedSupervisor.sendAgentEvent(toolExecutionStarted("call-1"));
    await crashedSupervisor.waitUntilRecorded(2);
    await crashedSupervisor.close();
    const client = await controlPlane.connectClient(threadId);
    await client.waitForSequence(2);

    const restartedSupervisor = await controlPlane.connectSupervisor(thread);
    await client.waitForSequence(3);

    expect(client.threadEvents[2]?.event).toEqual({
      type: "agent_failed",
      errorMessage: abandonedRunErrorMessage,
    });
    expect(welcomeOf(restartedSupervisor)).toEqual({
      type: "supervisor_welcome",
      lastRecordedEventNumber: 0,
    });
  });

  it("leaves the run open when the supervisor that started it reconnects, however long it was away", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    supervisor.sendAgentEvent(agentRunStarted);
    await supervisor.waitUntilRecorded(1);
    await supervisor.close();

    const reconnection = await controlPlane.connectSupervisor(thread, {
      supervisorInstanceId: supervisor.supervisorInstanceId,
    });
    reconnection.sendAgentEventNumbered(2, agentRunSettled);
    await reconnection.waitUntilRecorded(2);

    expect(await recordedEvents()).toEqual([agentRunStarted, agentRunSettled]);
  });

  it("closes nothing when the thread's last run has ended", async () => {
    const firstSupervisor = await controlPlane.connectSupervisor(thread);
    firstSupervisor.sendAgentEvent(agentRunStarted);
    firstSupervisor.sendAgentEvent(agentRunSettled);
    await firstSupervisor.waitUntilRecorded(2);
    await firstSupervisor.close();

    await controlPlane.connectSupervisor(thread);

    expect(await recordedEvents()).toEqual([agentRunStarted, agentRunSettled]);
  });

  it("leaves a disconnected supervisor's run open while no other supervisor attaches", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    supervisor.sendAgentEvent(agentRunStarted);
    await supervisor.waitUntilRecorded(1);
    const client = await controlPlane.connectClient(threadId);

    await supervisor.close();
    await client.inbox.waitFor(
      "told the supervisor is gone",
      (message) =>
        message.type === "supervisor_connection_status" && !message.isSupervisorConnected,
    );

    expect(await recordedEvents()).toEqual([agentRunStarted]);
  });
});

describe("a supervisor that claims what cannot be", () => {
  it("is refused when it claims to have delivered user messages beyond the thread's history", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread, { sayHello: false });

    supervisor.sendRawFrame(
      JSON.stringify({
        type: "supervisor_hello",
        supervisorInstanceId: supervisor.supervisorInstanceId,
        userMessagesDeliveredThroughSequence: 5,
      }),
    );

    expect((await supervisor.closed).closeCode).toBe(closeCodes.invalidMessage);
  });

  it("is refused when it skips an event number, and nothing it sent after is recorded", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);

    supervisor.sendAgentEventNumbered(1, agentRunStarted);
    supervisor.sendAgentEventNumbered(3, agentRunSettled);

    expect((await supervisor.closed).closeCode).toBe(closeCodes.invalidMessage);
    expect(await recordedEvents()).toEqual([agentRunStarted]);
  });

  it("is refused when it acknowledges user messages beyond any it was sent", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);
    supervisor.sendAgentEvent(agentRunStarted);
    await supervisor.waitUntilRecorded(1);

    supervisor.acknowledgeUserMessages(2);

    expect((await supervisor.closed).closeCode).toBe(closeCodes.invalidMessage);
    expect(await controlPlane.threadEventLog.readUserMessagesDeliveredThrough(threadId)).toBe(0);
  });

  it("is refused when it sends an agent event before saying hello", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread, { sayHello: false });

    supervisor.sendAgentEventNumbered(1, agentRunStarted);

    expect((await supervisor.closed).closeCode).toBe(closeCodes.invalidMessage);
    expect(await recordedEvents()).toEqual([]);
  });

  it("is refused when it says hello twice", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);

    await supervisor.sayHello();

    expect((await supervisor.closed).closeCode).toBe(closeCodes.invalidMessage);
  });
});
