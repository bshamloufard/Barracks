import { buildThreadApiPath, type ThreadSummary, threadResponseSchema } from "@barrack/protocol";
import { SandboxProviderUnavailableError } from "@barrack/sandbox-providers";
import { afterEach, describe, expect, it } from "vitest";
import { developmentUserId } from "../authentication/development-single-user.js";
import { ControllableClock } from "../test-support/controllable-clock.js";
import { agentRunStarted } from "../test-support/example-agent-events.js";
import { LaunchedSupervisors } from "../test-support/launched-supervisors.js";
import { readWholeThread } from "../test-support/read-whole-thread.js";
import { recordTestThread } from "../test-support/record-test-thread.js";
import {
  TestControlPlane,
  type TestControlPlaneOptions,
  testLifecycleSettings,
} from "../test-support/test-control-plane.js";
import type { ThreadRecord, ThreadSandboxRecord } from "../threads/thread-store.js";
import { runEndedBySandboxStoppingMessage, sandboxLostReason } from "./lifecycle-messages.js";
import { sandboxIdOf } from "./sandbox-operations.js";
import { decideRepair } from "./sandbox-reconciler.js";

/**
 * Reconciliation, through the real control plane with a fake provider whose
 * sandboxes run fake supervisors: what the control plane believes is
 * brought back in line with what the provider reports, and operations left
 * under way by a control plane that has gone are finished.
 */

const leaseDuration = 2 * testLifecycleSettings.checkIntervalInMilliseconds;

const controlPlanes: TestControlPlane[] = [];
let supervisors: LaunchedSupervisors;
let clock: ControllableClock;

afterEach(async () => {
  for (const controlPlane of controlPlanes.splice(0).reverse()) {
    await controlPlane.close();
  }
});

async function start(options: TestControlPlaneOptions = {}): Promise<TestControlPlane> {
  supervisors = new LaunchedSupervisors();
  clock = new ControllableClock();
  const controlPlane = await TestControlPlane.start({
    sandboxProvider: supervisors.provider,
    clock: clock.now,
    ...options,
  });
  supervisors.connectTo(controlPlane);
  controlPlanes.push(controlPlane);
  return controlPlane;
}

/** A second control plane on the same database and provider, as during a redeploy. */
async function startAnother(first: TestControlPlane): Promise<TestControlPlane> {
  const second = await TestControlPlane.start({
    threadStore: first.threadStore,
    threadEventLog: first.threadEventLog,
    sandboxProvider: first.sandboxProvider.reopen(),
    clock: clock.now,
  });
  controlPlanes.push(second);
  return second;
}

async function fetchThread(
  controlPlane: TestControlPlane,
  threadId: string,
): Promise<ThreadSummary> {
  const response = await controlPlane.getApi(buildThreadApiPath(threadId));
  return threadResponseSchema.parse(await response.json()).thread;
}

async function reconcile(controlPlane: TestControlPlane, includeSettledSandboxes = true) {
  await controlPlane.threadServices.reconciler.reconcile({ includeSettledSandboxes });
  await controlPlane.whenOperationsSettle();
}

async function recordedSandboxOf(controlPlane: TestControlPlane, threadId: string) {
  const thread = await controlPlane.threadStore.find(threadId);
  if (thread === undefined) {
    throw new Error(`No thread ${threadId}`);
  }
  return thread;
}

async function sandboxIdFor(controlPlane: TestControlPlane, threadId: string): Promise<string> {
  const sandboxId = sandboxIdOf((await recordedSandboxOf(controlPlane, threadId)).sandbox);
  if (sandboxId === undefined) {
    throw new Error(`No sandbox recorded for ${threadId}`);
  }
  return sandboxId;
}

/** Moves a thread into an operation as a control plane would, without carrying it out: one that then died. */
async function leaveOperationUnderWay(
  controlPlane: TestControlPlane,
  thread: ThreadRecord,
  to: ThreadSandboxRecord,
): Promise<void> {
  const outcome = await controlPlane.threadStore.transition({
    threadId: thread.threadId,
    fromVersion: thread.version,
    to,
    at: clock.now(),
  });
  expect(outcome.kind).toBe("changed");
}

function leaseFromNow(): Date {
  return new Date(clock.now().getTime() + leaseDuration);
}

describe("reconciling settled sandboxes with the provider", () => {
  it("records a running sandbox the provider stopped by itself as stopped, closing the run it left open", async () => {
    const controlPlane = await start();
    const { threadId } = await controlPlane.createThread();
    supervisors.latest(threadId).sendAgentEvent(agentRunStarted);
    await supervisors.latest(threadId).waitUntilRecorded(1);
    await controlPlane.sandboxProvider.markStopped(await sandboxIdFor(controlPlane, threadId));

    await reconcile(controlPlane, false);

    expect((await fetchThread(controlPlane, threadId)).sandbox).toEqual({ state: "stopped" });
    const events = await readWholeThread(controlPlane.threadEventLog, threadId);
    expect(events.at(-1)?.event).toEqual({
      type: "agent_failed",
      errorMessage: runEndedBySandboxStoppingMessage,
    });
  });

  it("records a sandbox that crashed as failed with the provider's reason, which resuming brings back", async () => {
    const controlPlane = await start();
    const { threadId } = await controlPlane.createThread();
    await controlPlane.sandboxProvider.markFailed(
      await sandboxIdFor(controlPlane, threadId),
      "its supervisor exited with code 1",
    );

    await reconcile(controlPlane, false);
    const afterReconciling = await fetchThread(controlPlane, threadId);
    await controlPlane.sendApi("POST", `${buildThreadApiPath(threadId)}/resume`);
    await controlPlane.whenOperationsSettle();

    expect(afterReconciling.sandbox).toEqual({
      state: "failed",
      reason: expect.stringContaining("its supervisor exited with code 1"),
      canResume: true,
    });
    expect((await fetchThread(controlPlane, threadId)).sandbox).toEqual({ state: "running" });
  });

  it("records a sandbox the provider has lost, running or stopped, as failed and gone", async () => {
    const controlPlane = await start();
    const { threadId: running } = await controlPlane.createThread();
    const { threadId: stopped } = await controlPlane.createThread();
    await controlPlane.sendApi("POST", `${buildThreadApiPath(stopped)}/stop`);
    await controlPlane.whenOperationsSettle();
    for (const threadId of [running, stopped]) {
      await controlPlane.sandboxProvider.markMissing(await sandboxIdFor(controlPlane, threadId));
    }

    await reconcile(controlPlane);

    for (const threadId of [running, stopped]) {
      expect((await fetchThread(controlPlane, threadId)).sandbox).toEqual({
        state: "failed",
        reason: sandboxLostReason,
        canResume: false,
      });
    }
  });

  it("records a sandbox recorded stopped that the provider runs as running, with a fresh idle period", async () => {
    const controlPlane = await start();
    const { threadId } = await controlPlane.createThread();
    await controlPlane.sendApi("POST", `${buildThreadApiPath(threadId)}/stop`);
    await controlPlane.whenOperationsSettle();
    await controlPlane.sandboxProvider.start(await sandboxIdFor(controlPlane, threadId));
    clock.advanceBy(60_000);

    await reconcile(controlPlane);

    const thread = await recordedSandboxOf(controlPlane, threadId);
    expect(thread.sandbox.state).toBe("running");
    expect(thread.lastActivityAt).toEqual(clock.now());
  });

  it("leaves a sandbox alone while the provider cannot say what state it is in", async () => {
    const controlPlane = await start();
    const { threadId } = await controlPlane.createThread();
    const before = await recordedSandboxOf(controlPlane, threadId);
    controlPlane.sandboxProvider.failNextOperation(
      new SandboxProviderUnavailableError("read sandbox", "the provider is down"),
      "getStatus",
    );

    await reconcile(controlPlane);

    expect(await recordedSandboxOf(controlPlane, threadId)).toEqual(before);
  });
});

describe("operations a control plane left under way", () => {
  it("takes over a stop once its lease has expired, and not before, and finishes it", async () => {
    const controlPlane = await start();
    const { threadId } = await controlPlane.createThread();
    const thread = await recordedSandboxOf(controlPlane, threadId);
    const sandboxId = await sandboxIdFor(controlPlane, threadId);
    await leaveOperationUnderWay(controlPlane, thread, {
      state: "stopping",
      sandboxId,
      leaseExpiresAt: leaseFromNow(),
    });

    clock.advanceBy(leaseDuration - 1);
    await reconcile(controlPlane);
    const beforeExpiry = await recordedSandboxOf(controlPlane, threadId);
    clock.advanceBy(1);
    await reconcile(controlPlane);

    expect(beforeExpiry.sandbox.state).toBe("stopping");
    expect((await fetchThread(controlPlane, threadId)).sandbox).toEqual({ state: "stopped" });
    expect(await controlPlane.sandboxProvider.getStatus(sandboxId)).toEqual({ state: "stopped" });
  });

  it("takes over a start whose control plane has gone, and the supervisor attaches", async () => {
    const controlPlane = await start();
    const { threadId } = await controlPlane.createThread();
    await controlPlane.sendApi("POST", `${buildThreadApiPath(threadId)}/stop`);
    await controlPlane.whenOperationsSettle();
    const stopped = await recordedSandboxOf(controlPlane, threadId);
    await leaveOperationUnderWay(controlPlane, stopped, {
      state: "starting",
      sandboxId: await sandboxIdFor(controlPlane, threadId),
      leaseExpiresAt: leaseFromNow(),
    });

    clock.advanceBy(leaseDuration);
    await reconcile(controlPlane);

    expect((await fetchThread(controlPlane, threadId)).sandbox).toEqual({ state: "running" });
    expect(supervisors.launchCount(threadId)).toBe(2);
  });

  it("finishes a creation whose control plane has gone, with a new token its supervisor connects with", async () => {
    const controlPlane = await start();
    await recordTestThread(
      controlPlane.threadStore,
      { threadId: "thread-left-creating", ownerUserId: developmentUserId },
      clock.now(),
    );

    clock.advanceBy(leaseDuration * 10);
    await reconcile(controlPlane);

    expect((await recordedSandboxOf(controlPlane, "thread-left-creating")).sandbox.state).toBe(
      "running",
    );
    expect(supervisors.launchCount("thread-left-creating")).toBe(1);
  });

  it("finishes a deletion whose control plane has gone", async () => {
    const controlPlane = await start();
    const { threadId } = await controlPlane.createThread();
    const thread = await recordedSandboxOf(controlPlane, threadId);
    const sandboxId = await sandboxIdFor(controlPlane, threadId);
    await leaveOperationUnderWay(controlPlane, thread, {
      state: "deleting",
      sandboxId,
      leaseExpiresAt: leaseFromNow(),
    });

    clock.advanceBy(leaseDuration);
    await reconcile(controlPlane);

    expect(await controlPlane.threadStore.find(threadId)).toBeUndefined();
    expect(await controlPlane.sandboxProvider.getStatus(sandboxId)).toEqual({ state: "missing" });
  });
});

describe("two control planes at once, as during a redeploy", () => {
  it("does not take over or fail a creation the other is still working on, which then finishes", async () => {
    const first = await start({ lifecycleSettings: { checkIntervalInMilliseconds: 40 } });
    const releaseCreation = first.sandboxProvider.holdNextOperation("create");
    const created = await first.postThread();
    const { thread } = threadResponseSchema.parse(await created.json());
    const second = await startAnother(first);

    for (let check = 0; check < 5; check += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      clock.advanceBy(40);
      await second.threadServices.reconciler.reconcile({ includeSettledSandboxes: true });
    }
    const whileCreating = await first.threadStore.find(thread.threadId);
    releaseCreation();
    await first.whenOperationsSettle();
    await second.whenOperationsSettle();

    expect(whileCreating?.sandbox.state).toBe("creating");
    expect((await fetchThread(first, thread.threadId)).sandbox).toEqual({ state: "running" });
    expect(first.sandboxProvider.calls.filter((call) => call.operation === "create")).toHaveLength(
      1,
    );
  });

  it("lets only one of them take over an abandoned stop", async () => {
    const first = await start();
    const { threadId } = await first.createThread();
    const second = await startAnother(first);
    const thread = await recordedSandboxOf(first, threadId);
    await leaveOperationUnderWay(first, thread, {
      state: "stopping",
      sandboxId: await sandboxIdFor(first, threadId),
      leaseExpiresAt: leaseFromNow(),
    });
    clock.advanceBy(leaseDuration);

    await Promise.all([reconcile(first), reconcile(second)]);

    const stops = [first, second].flatMap((controlPlane) =>
      controlPlane.sandboxProvider.calls.filter((call) => call.operation === "stop"),
    );
    expect(stops).toHaveLength(1);
    expect((await fetchThread(first, threadId)).sandbox).toEqual({ state: "stopped" });
  });
});

describe("deciding a repair", () => {
  it.each([
    ["running", "starting"],
    ["running", "stopping"],
    ["running", "running"],
    ["stopped", "stopped"],
    ["stopped", "failed"],
    ["stopped", "starting"],
  ] as const)("leaves a sandbox recorded %s that the provider reports %s", (recorded, reported) => {
    const recordedSandbox: ThreadSandboxRecord =
      recorded === "running"
        ? { state: "running", sandboxId: "sandbox-1", problem: undefined }
        : { state: "stopped", sandboxId: "sandbox-1", problem: undefined };
    const status =
      reported === "failed" ? { state: reported, reason: "It broke" } : { state: reported };

    expect(decideRepair(recordedSandbox, status)).toBeUndefined();
  });

  it("leaves a failed thread that never had a sandbox", () => {
    expect(
      decideRepair(
        { state: "failed", sandboxId: undefined, reason: "No quota" },
        { state: "missing" },
      ),
    ).toBeUndefined();
  });
});
