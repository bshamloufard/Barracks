import { pino } from "pino";
import { beforeAll, describe, expect, it } from "vitest";
import { acceptingThreadActivity } from "../test-support/accepting-thread-activity.js";
import { agentRunStarted } from "../test-support/example-agent-events.js";
import {
  allPendingWorkSettled,
  FakeClientConnection,
  FakeSupervisorConnection,
} from "../test-support/fake-connections.js";
import { recordTestThread } from "../test-support/record-test-thread.js";
import { InMemoryThreadEventLog } from "../thread-event-log/in-memory-thread-event-log.js";
import { InMemoryThreadStore } from "../threads/in-memory-thread-store.js";
import { ThreadAccess } from "../threads/thread-access.js";
import { ThreadRelayRegistry } from "./thread-relay-registry.js";

const threadId = "thread-1";
let access: ThreadAccess;

/** Clients are attached only with proof their user owns the thread, so the thread is given an owner. */
beforeAll(async () => {
  const threadStore = new InMemoryThreadStore();
  await recordTestThread(threadStore, { threadId, ownerUserId: "user-a" });
  const checkedAccess = await ThreadAccess.check(threadStore, "user-a", threadId);
  if (checkedAccess === undefined) {
    throw new Error("The thread's owner was refused access to it.");
  }
  access = checkedAccess;
});

function createRegistry(): ThreadRelayRegistry {
  return new ThreadRelayRegistry({
    threadEventLog: new InMemoryThreadEventLog(),
    threadActivity: acceptingThreadActivity,
    logger: pino({ level: "silent" }),
  });
}

describe("the thread relay registry", () => {
  it("hands every peer of a thread the same relay while any of them is attached", async () => {
    const registry = createRegistry();
    const supervisorRelay = registry.attachSupervisor(threadId, new FakeSupervisorConnection());
    const client = new FakeClientConnection();
    registry.attachClient(access, client, 0);
    await allPendingWorkSettled();

    supervisorRelay.detachClient(client);
    await allPendingWorkSettled();
    const laterRelay = registry.attachClient(access, new FakeClientConnection(), 0);

    expect(laterRelay).toBe(supervisorRelay);
  });

  it("drops a thread's relay once it has no supervisor, no clients and no queued work", async () => {
    const registry = createRegistry();
    const supervisor = new FakeSupervisorConnection();
    const client = new FakeClientConnection();
    const relay = registry.attachSupervisor(threadId, supervisor);
    registry.attachClient(access, client, 0);
    await allPendingWorkSettled();

    relay.detachClient(client);
    relay.detachSupervisor(supervisor);
    await allPendingWorkSettled();
    const laterRelay = registry.attachClient(access, new FakeClientConnection(), 0);

    expect(laterRelay).not.toBe(relay);
  });

  it("keeps a relay that a client attaches to while the relay's last queued work is running", async () => {
    const registry = createRegistry();
    const supervisor = new FakeSupervisorConnection();
    const relay = registry.attachSupervisor(threadId, supervisor);
    relay.receiveFromSupervisor(supervisor, supervisor.hello());
    await allPendingWorkSettled();

    relay.detachSupervisor(supervisor);
    const client = new FakeClientConnection();
    const clientRelay = registry.attachClient(access, client, 0);
    await allPendingWorkSettled();
    const laterRelay = registry.attachClient(access, new FakeClientConnection(), 0);

    expect(clientRelay).toBe(relay);
    expect(laterRelay).toBe(relay);
    expect(
      client.inbox.messages.findLast((message) => message.type === "supervisor_connection_status"),
    ).toEqual({ type: "supervisor_connection_status", isSupervisorConnected: false });
  });

  it("does not let a dropped relay remove the relay that replaced it", async () => {
    const registry = createRegistry();
    const firstClient = new FakeClientConnection();
    const droppedRelay = registry.attachClient(access, firstClient, 0);
    await allPendingWorkSettled();
    droppedRelay.detachClient(firstClient);
    const replacementRelay = registry.attachClient(access, new FakeClientConnection(), 0);
    await allPendingWorkSettled();

    // A supervisor whose socket finished closing only after its relay was dropped.
    droppedRelay.detachSupervisor(new FakeSupervisorConnection());
    await allPendingWorkSettled();
    const laterRelay = registry.attachClient(access, new FakeClientConnection(), 0);

    expect(laterRelay).toBe(replacementRelay);
  });

  it("keeps a thread's history when it drops the thread's relay", async () => {
    const registry = createRegistry();
    const supervisor = new FakeSupervisorConnection();
    const relay = registry.attachSupervisor(threadId, supervisor);
    relay.receiveFromSupervisor(supervisor, supervisor.hello());
    relay.receiveFromSupervisor(supervisor, supervisor.numbered(agentRunStarted));
    relay.detachSupervisor(supervisor);
    await allPendingWorkSettled();

    const client = new FakeClientConnection();
    registry.attachClient(access, client, 0);
    await allPendingWorkSettled();

    expect(client.inbox.messages.slice(0, 2)).toEqual([
      { type: "replay_announcement", firstSequence: 1, lastSequence: 1 },
      expect.objectContaining({ type: "thread_event", sequence: 1, event: agentRunStarted }),
    ]);
  });
});
