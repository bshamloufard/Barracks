import {
  apiErrorResponseSchema,
  buildResumeThreadApiPath,
  buildStopThreadApiPath,
  buildThreadApiPath,
  closeCodes,
  type ThreadEvent,
  type ThreadSummary,
  threadListResponseSchema,
  threadResponseSchema,
  threadsApiPath,
} from "@barrack/protocol";
import {
  SandboxNotFoundError,
  SandboxProviderUnavailableError,
  SandboxRefusedError,
} from "@barrack/sandbox-providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentRunSettled, agentRunStarted } from "../test-support/example-agent-events.js";
import { LaunchedSupervisors } from "../test-support/launched-supervisors.js";
import { readWholeThread } from "../test-support/read-whole-thread.js";
import {
  TestControlPlane,
  type TestControlPlaneOptions,
} from "../test-support/test-control-plane.js";
import { runEndedByStopMessage, sandboxLostReason } from "./lifecycle-messages.js";
import { sandboxIdOf as sandboxIdIn } from "./operation-outcomes.js";

/**
 * Stopping, resuming, waking and deleting threads through the real control
 * plane, with a fake provider whose sandboxes run fake supervisors that
 * connect back, and fail when told to.
 */

let controlPlane: TestControlPlane;
let supervisors: LaunchedSupervisors;

afterEach(async () => {
  await controlPlane?.close();
});

async function start(options: TestControlPlaneOptions = {}): Promise<void> {
  supervisors = new LaunchedSupervisors();
  controlPlane = await TestControlPlane.start({
    sandboxProvider: supervisors.provider,
    ...options,
  });
  supervisors.connectTo(controlPlane);
}

async function fetchThread(threadId: string): Promise<ThreadSummary> {
  const response = await controlPlane.getApi(buildThreadApiPath(threadId));
  expect(response.status).toBe(200);
  return threadResponseSchema.parse(await response.json()).thread;
}

async function listThreads(): Promise<ThreadSummary[]> {
  const response = await controlPlane.getApi(threadsApiPath);
  return threadListResponseSchema.parse(await response.json()).threads;
}

type ApiAnswer = { status: number; thread?: ThreadSummary; errorCode?: string; message?: string };

async function ask(method: "POST" | "DELETE", path: string): Promise<ApiAnswer> {
  const response =
    path === threadsApiPath
      ? await controlPlane.postThread()
      : await controlPlane.sendApi(method, path);
  const body: unknown = await response.json();
  const thread = threadResponseSchema.safeParse(body);
  if (thread.success) {
    return { status: response.status, thread: thread.data.thread };
  }
  const { error } = apiErrorResponseSchema.parse(body);
  return { status: response.status, errorCode: error.code, message: error.message };
}

const stopThread = (threadId: string) => ask("POST", buildStopThreadApiPath(threadId));
const resumeThread = (threadId: string) => ask("POST", buildResumeThreadApiPath(threadId));
const deleteThread = (threadId: string) => ask("DELETE", buildThreadApiPath(threadId));

async function stopAndSettle(threadId: string): Promise<void> {
  expect((await stopThread(threadId)).status).toBe(202);
  await controlPlane.whenOperationsSettle();
}

async function sandboxIdOf(threadId: string): Promise<string> {
  const thread = await controlPlane.threadStore.find(threadId);
  const sandboxId = thread === undefined ? undefined : sandboxIdIn(thread.sandbox);
  if (sandboxId === undefined) {
    throw new Error(`No sandbox is recorded for ${threadId}`);
  }
  return sandboxId;
}

async function eventsOf(threadId: string): Promise<ThreadEvent[]> {
  return (await readWholeThread(controlPlane.threadEventLog, threadId)).map(
    (recorded) => recorded.event,
  );
}

describe("stopping a thread", () => {
  it("interrupts the agent's run first, so it ends as the agent says, then stops the sandbox with its files kept", async () => {
    await start({ interruptGracePeriodInMilliseconds: 5_000 });
    const { threadId } = await controlPlane.createThread();
    const supervisor = supervisors.latest(threadId);
    supervisor.sendAgentEvent(agentRunStarted);
    await supervisor.waitUntilRecorded(1);
    const sandboxId = await sandboxIdOf(threadId);
    controlPlane.sandboxProvider.filesOf(sandboxId)?.set("/workspace/notes.txt", "kept");

    const answer = await stopThread(threadId);
    await supervisor.inbox.waitFor(
      "the interrupt",
      (message) => message.type === "interrupt_agent",
    );
    supervisor.sendAgentEvent({ type: "agent_run_settled", wasInterrupted: true });
    await controlPlane.whenOperationsSettle();

    expect(answer).toMatchObject({ status: 202, thread: { sandbox: { state: "stopping" } } });
    expect((await fetchThread(threadId)).sandbox).toEqual({ state: "stopped" });
    expect(await controlPlane.sandboxProvider.getStatus(sandboxId)).toEqual({ state: "stopped" });
    expect(controlPlane.sandboxProvider.filesOf(sandboxId)?.get("/workspace/notes.txt")).toBe(
      "kept",
    );
    expect(await eventsOf(threadId)).toEqual([
      agentRunStarted,
      { type: "agent_run_settled", wasInterrupted: true },
    ]);
  });

  it("closes in history a run the agent did not end before its sandbox stopped, and tells everyone watching", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    supervisors.latest(threadId).sendAgentEvent(agentRunStarted);
    await supervisors.latest(threadId).waitUntilRecorded(1);
    const client = await controlPlane.connectClient(threadId);

    await stopAndSettle(threadId);
    await client.waitForSequence(2);

    expect(await eventsOf(threadId)).toEqual([
      agentRunStarted,
      { type: "agent_failed", errorMessage: runEndedByStopMessage },
    ]);
    expect((await fetchThread(threadId)).isAgentWorking).toBe(false);
  });

  it("refuses to stop a sandbox that is not running, saying why", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    await stopAndSettle(threadId);

    const answer = await stopThread(threadId);

    expect(answer).toEqual({
      status: 409,
      errorCode: "conflict",
      message: "Its sandbox is already stopped.",
    });
  });

  it("lets only one of two stops at once through", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();

    const answers = await Promise.all([stopThread(threadId), stopThread(threadId)]);
    await controlPlane.whenOperationsSettle();

    expect(answers.map((answer) => answer.status).sort()).toEqual([202, 409]);
    expect(
      controlPlane.sandboxProvider.calls.filter((call) => call.operation === "stop"),
    ).toHaveLength(1);
  });
});

describe("resuming a thread", () => {
  it("starts its sandbox again, whose supervisor attaches as a new process and is handed the next message", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    await stopAndSettle(threadId);

    const answer = await resumeThread(threadId);
    await controlPlane.whenOperationsSettle();
    const client = await controlPlane.connectClient(threadId);
    client.sendUserMessage("Carry on");
    await supervisors
      .latest(threadId)
      .inbox.waitFor("the message", (message) => message.type === "deliver_user_message");

    expect(answer).toMatchObject({ status: 202, thread: { sandbox: { state: "starting" } } });
    expect((await fetchThread(threadId)).sandbox).toEqual({ state: "running" });
    expect(supervisors.launchCount(threadId)).toBe(2);
    expect(supervisors.messagesHandedOver(threadId)).toEqual(["Carry on"]);
  });

  it("refuses to resume a sandbox that is running, or one that is gone", async () => {
    await start();
    const { threadId: runningThreadId } = await controlPlane.createThread();
    const { threadId: lostThreadId } = await controlPlane.createThread();
    await controlPlane.sandboxProvider.markMissing(await sandboxIdOf(lostThreadId));
    await controlPlane.threadServices.reconciler.reconcile({ includeSettledSandboxes: false });

    expect(await resumeThread(runningThreadId)).toMatchObject({
      status: 409,
      message: "Its sandbox is already running.",
    });
    expect(await resumeThread(lostThreadId)).toMatchObject({
      status: 409,
      message: expect.stringContaining("Its sandbox is gone"),
    });
  });
});

describe("a message to a thread whose sandbox is stopped", () => {
  it("wakes the sandbox, shows it starting meanwhile, and is delivered exactly once when the agent is back", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    await stopAndSettle(threadId);
    const client = await controlPlane.connectClient(threadId);
    const releaseStart = controlPlane.sandboxProvider.holdNextOperation("start");

    client.sendUserMessage("Wake up");
    await client.waitForSequence(1);
    const whileWaking = await fetchThread(threadId);
    releaseStart();
    await controlPlane.whenOperationsSettle();
    const supervisor = supervisors.latest(threadId);
    await supervisor.inbox.waitFor(
      "the message",
      (message) => message.type === "deliver_user_message",
    );
    supervisors.acknowledgeDelivery(
      threadId,
      controlPlane.sandboxProvider.filesOf(await sandboxIdOf(threadId)),
    );
    await client.inbox.waitFor(
      "the message reported delivered",
      (message) =>
        message.type === "user_message_delivery_status" && message.deliveredThroughSequence === 1,
    );

    expect(whileWaking.sandbox).toEqual({ state: "starting" });
    expect((await fetchThread(threadId)).sandbox).toEqual({ state: "running" });
    expect(supervisors.messagesHandedOver(threadId)).toEqual(["Wake up"]);
    expect(client.inbox.messages.map((message) => message.type)).not.toContain(
      "client_message_rejected",
    );
  });

  it("sent while the sandbox is stopping wakes it once it has stopped", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    const client = await controlPlane.connectClient(threadId);
    const releaseStop = controlPlane.sandboxProvider.holdNextOperation("stop");

    await stopThread(threadId);
    client.sendUserMessage("Actually, one more thing");
    await client.waitForSequence(1);
    releaseStop();
    await controlPlane.whenOperationsSettle();

    expect((await fetchThread(threadId)).sandbox).toEqual({ state: "running" });
    expect(controlPlane.sandboxProvider.calls.map((call) => call.operation)).toEqual([
      "create",
      "stop",
      "start",
    ]);
    await supervisors
      .latest(threadId)
      .inbox.waitFor("the message", (message) => message.type === "deliver_user_message");
    expect(supervisors.messagesHandedOver(threadId)).toEqual(["Actually, one more thing"]);
  });

  it("sent while the sandbox is stopping wakes it even when the stop reports failing but the sandbox stopped", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    const client = await controlPlane.connectClient(threadId);
    const { sandboxProvider } = controlPlane;
    const stopSandbox = sandboxProvider.stop.bind(sandboxProvider);
    vi.spyOn(sandboxProvider, "stop").mockImplementationOnce(async (sandboxId) => {
      await stopSandbox(sandboxId);
      throw new SandboxProviderUnavailableError("stop sandbox", "the answer timed out");
    });
    const releaseStop = sandboxProvider.holdNextOperation("stop");

    await stopThread(threadId);
    client.sendUserMessage("Actually, one more thing");
    await client.waitForSequence(1);
    releaseStop();
    await controlPlane.whenOperationsSettle();

    expect((await fetchThread(threadId)).sandbox).toEqual({ state: "running" });
    await supervisors
      .latest(threadId)
      .inbox.waitFor("the message", (message) => message.type === "deliver_user_message");
    expect(supervisors.messagesHandedOver(threadId)).toEqual(["Actually, one more thing"]);
  });
});

describe("the limit on running sandboxes", () => {
  const twoPerUser = { admission: { maximumPerUser: 2, maximumInInstallation: undefined } };

  it("refuses a new thread once the user has as many running as allowed, naming them, and counts no stopped one", async () => {
    await start({ lifecycleSettings: twoPerUser });
    const first = await controlPlane.createThread();
    const client = await controlPlane.connectClient(first.threadId);
    client.sendUserMessage("Write the parser");
    await client.waitForSequence(1);
    await controlPlane.createThread();

    const refused = await ask("POST", threadsApiPath);
    await stopAndSettle(first.threadId);
    const afterStopping = await ask("POST", threadsApiPath);

    expect(refused).toEqual({
      status: 409,
      errorCode: "sandbox_limit_reached",
      message:
        'You already have 2 sandboxes running, the most allowed at once, so a new thread cannot start. Stop one of yours first: a thread with no messages yet (running), "Write the parser" (running).',
    });
    expect(afterStopping.status).toBe(201);
    expect(controlPlane.sandboxProvider.sandboxIds()).toHaveLength(3);
  });

  it("refuses to resume a thread, or wake it for a message, at the limit, and records no such message", async () => {
    await start({ lifecycleSettings: twoPerUser });
    const { threadId } = await controlPlane.createThread();
    await stopAndSettle(threadId);
    await controlPlane.createThread();
    await controlPlane.createThread();
    const client = await controlPlane.connectClient(threadId);

    const resumed = await resumeThread(threadId);
    const messageId = client.sendUserMessage("Hello?");
    const rejection = await client.inbox.waitFor(
      "the rejection",
      (message) => message.type === "client_message_rejected",
    );

    expect(resumed).toMatchObject({
      status: 409,
      errorCode: "sandbox_limit_reached",
      message: expect.stringContaining("so this thread cannot be resumed. Stop one of yours first"),
    });
    expect(rejection).toMatchObject({
      reason: expect.stringContaining("your message was not sent"),
      messageId,
    });
    expect(await eventsOf(threadId)).toEqual([]);
    expect((await fetchThread(threadId)).sandbox).toEqual({ state: "stopped" });
  });

  it("refuses a message, rather than leave it waiting, when the stopped sandbox could not be woken for it", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    await stopAndSettle(threadId);
    const client = await controlPlane.connectClient(threadId);
    vi.spyOn(controlPlane.threadStore, "transition").mockResolvedValue({ kind: "conflict" });

    const messageId = client.sendUserMessage("Hello?");
    const rejection = await client.inbox.waitFor(
      "the rejection",
      (message) => message.type === "client_message_rejected",
    );

    expect(rejection).toEqual({
      type: "client_message_rejected",
      reason: expect.stringContaining("kept changing"),
      messageId,
    });
    expect(await eventsOf(threadId)).toEqual([]);
  });

  it("counts a thread being deleted until its sandbox is destroyed, so deleting is no way past the limit", async () => {
    await start({
      lifecycleSettings: { admission: { maximumPerUser: 1, maximumInInstallation: undefined } },
    });
    const { threadId } = await controlPlane.createThread();
    const releaseDestroy = controlPlane.sandboxProvider.holdNextOperation("destroy");

    const deletion = await deleteThread(threadId);
    const whileDestroying = await ask("POST", threadsApiPath);
    releaseDestroy();
    await controlPlane.whenOperationsSettle();
    const once = await ask("POST", threadsApiPath);

    expect(deletion.status).toBe(202);
    expect(whileDestroying).toMatchObject({
      status: 409,
      message: expect.stringContaining(
        "Stop one of yours first: a thread with no messages yet (being deleted; wait a moment).",
      ),
    });
    expect(once.status).toBe(201);
  });

  it("refuses anyone at the installation's limit", async () => {
    await start({
      lifecycleSettings: { admission: { maximumPerUser: 5, maximumInInstallation: 1 } },
    });
    await controlPlane.createThread();

    const refused = await ask("POST", threadsApiPath);

    expect(refused).toMatchObject({
      status: 409,
      message: expect.stringMatching(
        /^This installation already runs 1 sandbox, the most it allows at once/,
      ),
    });
  });
});

describe("deleting a thread", () => {
  it("destroys its sandbox and removes it and its history for good, disconnecting whoever watches", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    const client = await controlPlane.connectClient(threadId);
    client.sendUserMessage("Something to forget");
    await client.waitForSequence(1);
    const sandboxId = await sandboxIdOf(threadId);

    const answer = await deleteThread(threadId);
    await controlPlane.whenOperationsSettle();

    expect(answer).toMatchObject({ status: 202, thread: { sandbox: { state: "deleting" } } });
    expect((await controlPlane.getApi(buildThreadApiPath(threadId))).status).toBe(404);
    expect(await listThreads()).toEqual([]);
    expect(await controlPlane.sandboxProvider.getStatus(sandboxId)).toEqual({ state: "missing" });
    expect(await eventsOf(threadId)).toEqual([]);
    expect(await client.closed).toMatchObject({ closeCode: closeCodes.threadNotFound });
  });

  it("leaves no history behind for a message admitted just before the deletion began and recorded after it", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    const client = await controlPlane.connectClient(threadId);
    const recording = controlPlane.threadEventLog.holdNextAppend();
    client.sendUserMessage("Sent as the thread is deleted");
    await recording.beforeRecording.reached;

    await deleteThread(threadId);
    await vi.waitFor(async () => {
      expect(await controlPlane.threadStore.find(threadId)).toBeUndefined();
    });
    recording.beforeRecording.release();
    recording.afterRecording.release();
    await controlPlane.whenOperationsSettle();

    expect(await eventsOf(threadId)).toEqual([]);
    expect(await controlPlane.threadEventLog.readNewestSequence(threadId)).toBe(0);
  });

  it("deletes a stopped thread, and one whose sandbox the provider has already lost", async () => {
    await start();
    const { threadId: stoppedThreadId } = await controlPlane.createThread();
    const { threadId: lostThreadId } = await controlPlane.createThread();
    await stopAndSettle(stoppedThreadId);
    await controlPlane.sandboxProvider.markMissing(await sandboxIdOf(lostThreadId));

    const answers = await Promise.all([deleteThread(stoppedThreadId), deleteThread(lostThreadId)]);
    await controlPlane.whenOperationsSettle();

    expect(answers.map((answer) => answer.status)).toEqual([202, 202]);
    expect(await listThreads()).toEqual([]);
  });

  it("refuses to delete while the sandbox is stopping, and lets only one of two deletions through", async () => {
    await start();
    const { threadId: stoppingThreadId } = await controlPlane.createThread();
    const { threadId } = await controlPlane.createThread();
    const releaseStop = controlPlane.sandboxProvider.holdNextOperation("stop");
    await stopThread(stoppingThreadId);

    const whileStopping = await deleteThread(stoppingThreadId);
    const racing = await Promise.all([deleteThread(threadId), deleteThread(threadId)]);
    releaseStop();
    await controlPlane.whenOperationsSettle();

    expect(whileStopping).toMatchObject({ status: 409, errorCode: "conflict" });
    expect(racing.map((answer) => answer.status).sort()).toEqual([202, 409]);
    expect(
      controlPlane.sandboxProvider.calls.filter((call) => call.operation === "destroy"),
    ).toHaveLength(1);
  });
});

describe("a provider failing in the middle of a change", () => {
  it.each([
    ["unavailable", new SandboxProviderUnavailableError("stop sandbox", "the provider timed out")],
    ["refusing", new SandboxRefusedError("stop sandbox", "the quota is used up")],
  ])("leaves a sandbox it could not stop (%s) running, saying why", async (_, error) => {
    await start();
    const { threadId } = await controlPlane.createThread();
    controlPlane.sandboxProvider.failNextOperation(error, "stop");

    await stopAndSettle(threadId);

    expect((await fetchThread(threadId)).sandbox).toEqual({
      state: "running",
      problem: expect.stringMatching(
        /^Its sandbox could not be stopped: .* It is still running\.$/,
      ),
    });
    expect((await stopThread(threadId)).status).toBe(202);
  });

  it.each([
    ["unavailable", new SandboxProviderUnavailableError("start sandbox", "the provider timed out")],
    ["refusing", new SandboxRefusedError("start sandbox", "the quota is used up")],
  ])("leaves a sandbox it could not start (%s) stopped, saying why", async (_, error) => {
    await start();
    const { threadId } = await controlPlane.createThread();
    await stopAndSettle(threadId);
    controlPlane.sandboxProvider.failNextOperation(error, "start");

    await resumeThread(threadId);
    await controlPlane.whenOperationsSettle();

    expect((await fetchThread(threadId)).sandbox).toEqual({
      state: "stopped",
      problem: expect.stringMatching(/^Its sandbox could not be started: .* It is stopped\.$/),
    });
  });

  it("records a sandbox the provider no longer has, when stopping or starting it, as gone", async () => {
    await start();
    const { threadId: stopped } = await controlPlane.createThread();
    const { threadId: started } = await controlPlane.createThread();
    await stopAndSettle(started);
    controlPlane.sandboxProvider.failNextOperation(new SandboxNotFoundError("stop", "x"), "stop");
    await stopAndSettle(stopped);
    controlPlane.sandboxProvider.failNextOperation(new SandboxNotFoundError("start", "x"), "start");
    await resumeThread(started);
    await controlPlane.whenOperationsSettle();

    for (const threadId of [stopped, started]) {
      expect((await fetchThread(threadId)).sandbox).toEqual({
        state: "failed",
        reason: sandboxLostReason,
        canResume: false,
      });
    }
  });

  it("keeps a thread it could not delete, as the provider reports its sandbox, saying why", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    controlPlane.sandboxProvider.failNextOperation(
      new SandboxProviderUnavailableError("destroy sandbox", "the provider timed out"),
      "destroy",
    );

    await deleteThread(threadId);
    await controlPlane.whenOperationsSettle();

    expect((await fetchThread(threadId)).sandbox).toEqual({
      state: "running",
      problem: expect.stringMatching(/^This thread could not be deleted: .*the provider timed out/),
    });
  });

  it("records a sandbox as failed, resumable, when neither the operation nor its state can be read", async () => {
    await start();
    const { threadId } = await controlPlane.createThread();
    controlPlane.sandboxProvider.failNextOperation(
      new SandboxProviderUnavailableError("stop sandbox", "the provider timed out"),
      "stop",
    );
    const unreadable = new SandboxProviderUnavailableError(
      "read sandbox",
      "the provider timed out",
    );
    vi.spyOn(controlPlane.sandboxProvider, "getStatus")
      .mockRejectedValueOnce(unreadable)
      .mockRejectedValueOnce(unreadable);

    await stopAndSettle(threadId);

    expect((await fetchThread(threadId)).sandbox).toEqual({
      state: "failed",
      reason: expect.stringMatching(/^Its sandbox could not be stopped: .* Try again later\.$/),
      canResume: true,
    });
  });
});

describe("the thread list", () => {
  it("shows each thread's title from its first message, whether its agent is working, and the most recently active first", async () => {
    await start();
    const { threadId: older } = await controlPlane.createThread();
    const { threadId: newer } = await controlPlane.createThread();
    const client = await controlPlane.connectClient(older);
    client.sendUserMessage("Fix the flaky login test\nIt fails one run in ten.");
    client.sendUserMessage("And then the docs");
    await client.waitForSequence(2);
    supervisors.latest(older).sendAgentEvent(agentRunStarted);
    await supervisors.latest(older).waitUntilRecorded(1);

    const listed = await listThreads();

    expect(listed.map((thread) => thread.threadId)).toEqual([older, newer]);
    expect(listed[0]).toMatchObject({ title: "Fix the flaky login test", isAgentWorking: true });
    expect(listed[1]).toMatchObject({ title: null, isAgentWorking: false });
    supervisors.latest(older).sendAgentEvent(agentRunSettled);
    await supervisors.latest(older).waitUntilRecorded(2);
    expect((await fetchThread(older)).isAgentWorking).toBe(false);
  });
});
