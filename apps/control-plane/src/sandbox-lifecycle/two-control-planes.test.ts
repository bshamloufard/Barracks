import { buildStopThreadApiPath } from "@barrack/protocol";
import { FakeSandboxProvider } from "@barrack/sandbox-providers";
import { afterEach, describe, expect, it } from "vitest";
import { ControllableThreadEventLog } from "../test-support/controllable-thread-event-log.js";
import { agentRunSettled, agentRunStarted } from "../test-support/example-agent-events.js";
import { readWholeThread } from "../test-support/read-whole-thread.js";
import { TestControlPlane } from "../test-support/test-control-plane.js";
import { InMemoryThreadStore } from "../threads/in-memory-thread-store.js";

/*
 * Railway runs two control plane instances at once for a while during a
 * redeploy, sharing one database. These tests start two over one thread
 * store and one event log, with a supervisor attached to one of them.
 */

let controlPlanes: TestControlPlane[] = [];
let threadEventLog: ControllableThreadEventLog;

afterEach(async () => {
  await Promise.all(controlPlanes.map((controlPlane) => controlPlane.close()));
  controlPlanes = [];
});

async function startTwoControlPlanes(): Promise<[TestControlPlane, TestControlPlane]> {
  threadEventLog = new ControllableThreadEventLog();
  const shared = {
    threadEventLog,
    threadStore: new InMemoryThreadStore(),
    sandboxProvider: new FakeSandboxProvider(),
  };
  const first = await TestControlPlane.start(shared);
  const second = await TestControlPlane.start(shared);
  controlPlanes = [first, second];
  return [first, second];
}

async function runBoundaries(threadId: string): Promise<string[]> {
  const history = await readWholeThread(threadEventLog, threadId);
  return history.flatMap(({ event }) =>
    event.type === "agent_run_started" ||
    event.type === "agent_run_settled" ||
    event.type === "agent_failed"
      ? [event.type]
      : [],
  );
}

describe("a run's end, with two control planes", () => {
  it("is recorded once when one stops the sandbox as the agent, attached to the other, ends its run", async () => {
    const [stopping, attached] = await startTwoControlPlanes();
    const thread = await stopping.createThread();
    const supervisor = await attached.connectSupervisor(thread);
    supervisor.sendAgentEvent(agentRunStarted);
    await supervisor.waitUntilRecorded(1);
    const closingAppend = threadEventLog.holdNextAppend();

    const stop = await stopping.sendApi("POST", buildStopThreadApiPath(thread.threadId));
    await closingAppend.beforeRecording.reached;
    supervisor.sendAgentEvent(agentRunSettled);
    await supervisor.waitUntilRecorded(2);
    closingAppend.beforeRecording.release();
    closingAppend.afterRecording.release();
    await stopping.whenOperationsSettle();

    expect(stop.status).toBe(202);
    expect(await runBoundaries(thread.threadId)).toEqual([
      "agent_run_started",
      "agent_run_settled",
    ]);
  });

  it("is recorded once when a new supervisor process says hello to both, and both find the old one's run open", async () => {
    const [first, second] = await startTwoControlPlanes();
    const thread = await first.createThread();
    const vanished = await first.connectSupervisor(thread);
    vanished.sendAgentEvent(agentRunStarted);
    await vanished.waitUntilRecorded(1);
    await vanished.close();
    const closingAppend = threadEventLog.holdNextAppend();

    const replacement = await first.connectSupervisor(thread, { sayHello: false });
    const welcomedByFirst = replacement.sayHello();
    await closingAppend.beforeRecording.reached;
    await second.connectSupervisor(thread, {
      supervisorInstanceId: replacement.supervisorInstanceId,
    });
    closingAppend.beforeRecording.release();
    closingAppend.afterRecording.release();
    await welcomedByFirst;

    expect(await runBoundaries(thread.threadId)).toEqual(["agent_run_started", "agent_failed"]);
  });
});
