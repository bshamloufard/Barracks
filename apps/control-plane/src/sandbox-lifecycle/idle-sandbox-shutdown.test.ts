import { buildThreadApiPath, type ThreadSummary, threadResponseSchema } from "@barrack/protocol";
import { type FakeSandboxLaunch, FakeSandboxProvider } from "@barrack/sandbox-providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControllableClock } from "../test-support/controllable-clock.js";
import {
  agentRunSettled,
  agentRunStarted,
  toolExecutionStarted,
} from "../test-support/example-agent-events.js";
import { LaunchedSupervisors } from "../test-support/launched-supervisors.js";
import { TestControlPlane, testLifecycleSettings } from "../test-support/test-control-plane.js";
import { connectFakeSupervisor } from "../test-support/test-peers.js";

/**
 * Idle shutdown, with a clock the test moves on: a running sandbox is
 * stopped once nothing has happened in its thread for the idle period, its
 * agent has no run open and no message waits for it, and never otherwise.
 */

const idlePeriod = testLifecycleSettings.idlePeriodInMilliseconds;

let controlPlane: TestControlPlane;
let supervisors: LaunchedSupervisors;
let clock: ControllableClock;

afterEach(async () => {
  await controlPlane?.close();
});

async function start(): Promise<void> {
  supervisors = new LaunchedSupervisors();
  clock = new ControllableClock();
  controlPlane = await TestControlPlane.start({
    sandboxProvider: supervisors.provider,
    clock: clock.now,
  });
  supervisors.connectTo(controlPlane);
}

async function stopIdleSandboxes(): Promise<void> {
  await controlPlane.threadServices.idleShutdown.stopIdleSandboxes();
  await controlPlane.whenOperationsSettle();
}

async function sandboxStateOf(threadId: string): Promise<ThreadSummary["sandbox"]["state"]> {
  const response = await controlPlane.getApi(buildThreadApiPath(threadId));
  return threadResponseSchema.parse(await response.json()).thread.sandbox.state;
}

describe("idle shutdown", () => {
  it("stops a sandbox once it has been idle for the whole idle period, and not a moment before", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();

    clock.advanceBy(idlePeriod - 1);
    await stopIdleSandboxes();
    const justBefore = await sandboxStateOf(threadId);
    clock.advanceBy(1);
    await stopIdleSandboxes();

    expect(justBefore).toBe("running");
    expect(await sandboxStateOf(threadId)).toBe("stopped");
  });

  it("counts a user message and an agent event as activity, but not a client merely watching", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    const supervisor = supervisors.latest(threadId);
    const client = await controlPlane.connectClient(threadId);

    clock.advanceBy(idlePeriod / 2);
    client.sendUserMessage("Are you there?");
    await client.waitForSequence(1);
    await supervisor.inbox.waitFor(
      "the message",
      (message) => message.type === "deliver_user_message",
    );
    supervisors.acknowledgeDelivery(threadId, undefined);
    await client.inbox.waitFor(
      "the delivery",
      (message) =>
        message.type === "user_message_delivery_status" && message.deliveredThroughSequence === 1,
    );
    clock.advanceBy(idlePeriod / 2);
    await stopIdleSandboxes();
    const afterMessage = await sandboxStateOf(threadId);
    supervisor.sendAgentEvent(agentRunStarted);
    supervisor.sendAgentEvent(agentRunSettled);
    await supervisor.waitUntilRecorded(2);
    clock.advanceBy(idlePeriod - 1);
    await stopIdleSandboxes();
    const afterAgentEvent = await sandboxStateOf(threadId);
    await controlPlane.connectClient(threadId);
    clock.advanceBy(1);
    await stopIdleSandboxes();

    expect(afterMessage).toBe("running");
    expect(afterAgentEvent).toBe("running");
    expect(await sandboxStateOf(threadId)).toBe("stopped");
  });

  it("leaves a sandbox whose supervisor has not attached yet, and gives it a whole idle period once one does", async () => {
    const launches: FakeSandboxLaunch[] = [];
    clock = new ControllableClock();
    controlPlane = await TestControlPlane.start({
      sandboxProvider: new FakeSandboxProvider({
        supervisorLauncher: (launch) => {
          launches.push(launch);
          return { stop: async () => undefined };
        },
      }),
      clock: clock.now,
    });
    const { threadId } = await controlPlane.createThread();

    clock.advanceBy(idlePeriod * 2);
    await stopIdleSandboxes();
    const whileStarting = await sandboxStateOf(threadId);
    const { BARRACK_SUPERVISOR_TOKEN: token = "" } = launches[0]?.supervisorSecrets ?? {};
    const supervisor = await connectFakeSupervisor(controlPlane.baseUrl, threadId, token);
    await supervisor.sayHello(0);
    await vi.waitFor(async () => {
      expect((await controlPlane.threadStore.find(threadId))?.awaitingSupervisorSince).toBe(
        undefined,
      );
    });
    clock.advanceBy(idlePeriod - 1);
    await stopIdleSandboxes();
    const justBeforeAWholePeriod = await sandboxStateOf(threadId);
    clock.advanceBy(1);
    await stopIdleSandboxes();

    expect(whileStarting).toBe("running");
    expect(justBeforeAWholePeriod).toBe("running");
    expect(await sandboxStateOf(threadId)).toBe("stopped");
    await supervisor.close();
  });

  it("never stops a sandbox whose agent has a run open, however long it is quiet", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    const supervisor = supervisors.latest(threadId);
    supervisor.sendAgentEvent(agentRunStarted);
    supervisor.sendAgentEvent(toolExecutionStarted("a-long-build"));
    await supervisor.waitUntilRecorded(2);

    clock.advanceBy(idlePeriod * 10);
    await stopIdleSandboxes();

    expect(await sandboxStateOf(threadId)).toBe("running");
  });

  it("never stops a sandbox with a message still waiting to be handed to its agent", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    const client = await controlPlane.connectClient(threadId);
    client.sendUserMessage("Hand this over, please");
    await client.waitForSequence(1);

    clock.advanceBy(idlePeriod * 2);
    await stopIdleSandboxes();
    const whileWaiting = await sandboxStateOf(threadId);
    supervisors.acknowledgeDelivery(threadId, undefined);
    await client.inbox.waitFor(
      "the delivery",
      (message) =>
        message.type === "user_message_delivery_status" && message.deliveredThroughSequence === 1,
    );
    await stopIdleSandboxes();

    expect(whileWaiting).toBe("running");
    expect(await sandboxStateOf(threadId)).toBe("stopped");
  });

  it("keeps a sandbox running when a message arrives between deciding it is idle and stopping it", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    clock.advanceBy(idlePeriod);
    const readAgentWork = controlPlane.threadEventLog.readAgentWork.bind(
      controlPlane.threadEventLog,
    );
    vi.spyOn(controlPlane.threadEventLog, "readAgentWork").mockImplementationOnce(
      async (idleThreadId) => {
        await controlPlane.threadStore.recordUserMessageArrival(idleThreadId, {
          at: clock.now(),
          title: undefined,
        });
        return readAgentWork(idleThreadId);
      },
    );

    await stopIdleSandboxes();

    expect(await sandboxStateOf(threadId)).toBe("running");
    expect(controlPlane.sandboxProvider.calls.map((call) => call.operation)).toEqual(["create"]);
  });
});
