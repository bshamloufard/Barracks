import {
  buildThreadApiPath,
  type ThreadSummary,
  threadListResponseSchema,
  threadResponseSchema,
  threadsApiPath,
} from "@barrack/protocol";
import {
  FakeSandboxProvider,
  SandboxAlreadyExistsError,
  SandboxProviderUnavailableError,
  SandboxRefusedError,
} from "@barrack/sandbox-providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developmentAccessToken } from "../authentication/development-single-user.js";
import { ControllableClock } from "../test-support/controllable-clock.js";
import { toolExecutionStarted } from "../test-support/example-agent-events.js";
import { readWholeThread } from "../test-support/read-whole-thread.js";
import {
  browserHeaders,
  TestControlPlane,
  type TestControlPlaneOptions,
  testLifecycleSettings,
} from "../test-support/test-control-plane.js";
import { authorizeWithThreadTokens } from "../websocket/supervisor-authorization.js";
import { InMemoryThreadStore } from "./in-memory-thread-store.js";

let controlPlane: TestControlPlane;

afterEach(async () => {
  await controlPlane?.close();
});

async function start(options: TestControlPlaneOptions = {}): Promise<TestControlPlane> {
  controlPlane = await TestControlPlane.start(options);
  return controlPlane;
}

async function createThreadThroughApi(): Promise<ThreadSummary> {
  const response = await controlPlane.postThread();
  expect(response.status).toBe(201);
  return threadResponseSchema.parse(await response.json()).thread;
}

async function fetchThread(threadId: string): Promise<ThreadSummary> {
  const response = await controlPlane.getApi(buildThreadApiPath(threadId));
  expect(response.status).toBe(200);
  return threadResponseSchema.parse(await response.json()).thread;
}

async function listThreads(): Promise<ThreadSummary[]> {
  const response = await controlPlane.getApi(threadsApiPath);
  expect(response.status).toBe(200);
  return threadListResponseSchema.parse(await response.json()).threads;
}

/** A launcher that holds every sandbox in `starting` until the test lets it go. */
function heldSandboxCreation(): { provider: FakeSandboxProvider; release: () => void } {
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const provider = new FakeSandboxProvider({
    supervisorLauncher: async () => {
      await released;
      return undefined;
    },
  });
  return { provider, release };
}

describe("creating a thread", () => {
  it("answers at once with the thread's sandbox being created, then shows it ready once the provider has made it", async () => {
    const { provider, release } = heldSandboxCreation();
    await start({ sandboxProvider: provider });

    const created = await createThreadThroughApi();
    const whileCreating = await fetchThread(created.threadId);
    release();
    await controlPlane.whenOperationsSettle();

    expect(created.sandbox).toEqual({ state: "creating" });
    expect(whileCreating.sandbox).toEqual({ state: "creating" });
    expect((await fetchThread(created.threadId)).sandbox).toEqual({ state: "running" });
  });

  it("asks the provider once for a sandbox whose supervisor is told the thread, the control plane and a token of its own", async () => {
    await start();

    const { threadId, supervisorToken } = await controlPlane.createThread();

    const creations = controlPlane.sandboxProvider.calls.filter(
      (call) => call.operation === "create",
    );
    expect(creations).toEqual([
      {
        operation: "create",
        request: {
          threadId,
          supervisorEnvironment: {
            BARRACK_CONTROL_PLANE_URL: "ws://control-plane.test:8787",
            BARRACK_THREAD_ID: threadId,
            BARRACK_SUPERVISOR_TOKEN: supervisorToken,
            BARRACK_AGENT_HARNESS: "fake",
          },
        },
      },
    ]);
    expect(supervisorToken.length).toBeGreaterThanOrEqual(43);
  });

  it("never shows the supervisor's token in an API response or in the log", async () => {
    await start();

    const { threadId, supervisorToken } = await controlPlane.createThread();
    await controlPlane.connectSupervisor({ threadId, supervisorToken });
    const responses = await Promise.all([
      controlPlane.getApi(buildThreadApiPath(threadId)).then((r) => r.text()),
      controlPlane.getApi(threadsApiPath).then((r) => r.text()),
    ]);

    expect(controlPlane.logLines.length).toBeGreaterThan(0);
    for (const text of [...responses, ...controlPlane.logLines]) {
      expect(text).not.toContain(supervisorToken);
    }
  });

  it("lists threads most recently active first, each with when it was created and last active, and its sandbox's state", async () => {
    await start();
    const first = await controlPlane.createThread();
    const second = await controlPlane.createThread();

    const threads = await listThreads();

    expect(threads.map((thread) => thread.threadId)).toEqual([second.threadId, first.threadId]);
    expect(threads[0]).toEqual({
      threadId: second.threadId,
      createdAt: expect.any(String),
      lastActiveAt: expect.any(String),
      title: null,
      isAgentWorking: false,
      sandbox: { state: "running" },
      repository: null,
    });
  });

  it("gives two threads created at once different identifiers, tokens and sandboxes, and keeps their events apart", async () => {
    await start();

    const [first, second] = await Promise.all([
      controlPlane.createThread(),
      controlPlane.createThread(),
    ]);
    const firstSupervisor = await controlPlane.connectSupervisor(first);
    const secondSupervisor = await controlPlane.connectSupervisor(second);
    const firstClient = await controlPlane.connectClient(first.threadId);
    const secondClient = await controlPlane.connectClient(second.threadId);
    firstSupervisor.sendAgentEvent(toolExecutionStarted("first-thread-call"));
    secondSupervisor.sendAgentEvent(toolExecutionStarted("second-thread-call"));
    await firstClient.waitForSequence(1);
    await secondClient.waitForSequence(1);

    expect(first.threadId).not.toBe(second.threadId);
    expect(first.supervisorToken).not.toBe(second.supervisorToken);
    expect(controlPlane.sandboxProvider.sandboxIds()).toHaveLength(2);
    expect(firstClient.threadEvents.map((recorded) => recorded.event)).toEqual([
      toolExecutionStarted("first-thread-call"),
    ]);
    expect(secondClient.threadEvents.map((recorded) => recorded.event)).toEqual([
      toolExecutionStarted("second-thread-call"),
    ]);
    expect(await readWholeThread(controlPlane.threadEventLog, first.threadId)).toHaveLength(1);
    expect(await readWholeThread(controlPlane.threadEventLog, second.threadId)).toHaveLength(1);
  });
});

describe("a sandbox that cannot be created", () => {
  it("leaves the thread failed with the provider's refusal as the reason, and no sandbox behind", async () => {
    await start();
    controlPlane.sandboxProvider.failNextOperation(
      new SandboxRefusedError("create a sandbox", "the image does not exist"),
      "create",
    );

    const { threadId } = await createThreadThroughApi();
    await controlPlane.whenOperationsSettle();

    expect((await fetchThread(threadId)).sandbox).toEqual({
      state: "failed",
      reason:
        "Its sandbox could not be created: Could not create a sandbox: the image does not exist. Delete this thread and create a new one to try again.",
      canResume: false,
    });
    expect(controlPlane.sandboxProvider.sandboxIds()).toEqual([]);
  });

  it("leaves the thread failed, saying to try again later, when the provider stays unavailable", async () => {
    await start({ retryDelaysInMilliseconds: [] });
    controlPlane.sandboxProvider.failNextOperation(
      new SandboxProviderUnavailableError("create a sandbox", "the provider timed out"),
      "create",
    );

    const { threadId } = await createThreadThroughApi();
    await controlPlane.whenOperationsSettle();

    expect((await fetchThread(threadId)).sandbox).toEqual({
      state: "failed",
      reason: expect.stringMatching(/the provider timed out\. .*create a new one to try again/),
      canResume: false,
    });
    expect(controlPlane.sandboxProvider.sandboxIds()).toEqual([]);
  });

  it("is tried again while the provider is unavailable, and the thread becomes ready when it answers", async () => {
    await start({ retryDelaysInMilliseconds: [0] });
    controlPlane.sandboxProvider.failNextOperation(
      new SandboxProviderUnavailableError("create a sandbox", "the provider timed out"),
      "create",
    );

    const { threadId } = await createThreadThroughApi();
    await controlPlane.whenOperationsSettle();

    expect((await fetchThread(threadId)).sandbox).toEqual({ state: "running" });
    expect(controlPlane.sandboxProvider.sandboxIds()).toHaveLength(1);
  });

  it("takes the sandbox an earlier, apparently failed, attempt created after all, and makes sure it runs", async () => {
    const sandboxProvider = new FakeSandboxProvider();
    vi.spyOn(sandboxProvider, "create")
      .mockRejectedValueOnce(
        new SandboxProviderUnavailableError("create a sandbox", "the request timed out"),
      )
      .mockRejectedValueOnce(new SandboxAlreadyExistsError("thread", "sandbox-from-attempt-1"));
    const startSandbox = vi.spyOn(sandboxProvider, "start").mockResolvedValue();
    const threadStore = new InMemoryThreadStore();
    await start({ sandboxProvider, threadStore, retryDelaysInMilliseconds: [0] });

    const { threadId } = await createThreadThroughApi();
    await controlPlane.whenOperationsSettle();

    expect((await threadStore.find(threadId))?.sandbox).toEqual({
      state: "running",
      sandboxId: "sandbox-from-attempt-1",
      problem: undefined,
    });
    expect(startSandbox).toHaveBeenCalledWith("sandbox-from-attempt-1");
  });

  it("is taken as the thread's when a creation whose outcome could not be recorded is taken over", async () => {
    const threadStore = new InMemoryThreadStore();
    const clock = new ControllableClock();
    const recordOutcome = vi
      .spyOn(threadStore, "transition")
      .mockRejectedValueOnce(new Error("The database went away"));
    await start({ threadStore, clock: clock.now });

    const { threadId } = await createThreadThroughApi();
    await controlPlane.whenOperationsSettle();
    const whileUnrecorded = await fetchThread(threadId);
    recordOutcome.mockRestore();
    clock.advanceBy(testLifecycleSettings.checkIntervalInMilliseconds * 3);
    await controlPlane.threadServices.reconciler.reconcile({ includeSettledSandboxes: false });
    await controlPlane.whenOperationsSettle();

    expect(whileUnrecorded.sandbox).toEqual({ state: "creating" });
    expect((await fetchThread(threadId)).sandbox).toEqual({ state: "running" });
    expect(controlPlane.sandboxProvider.sandboxIds()).toHaveLength(1);
    expect(controlPlane.sandboxProvider.calls.map((call) => call.operation)).toEqual([
      "create",
      "create",
      "start",
    ]);
  });
});

describe("a creation taken over from a control plane that has gone", () => {
  /** Whether the control plane would let a supervisor holding `token` connect for the thread. */
  function acceptsSupervisorToken(threadId: string, token: string): Promise<boolean> {
    return authorizeWithThreadTokens(controlPlane.threadStore)({
      threadId,
      authorizationHeader: `Bearer ${token}`,
    });
  }

  /** Makes the next `count` records of a sandbox running fail, as a control plane dying just then would. */
  function loseRecordsOfRunning(threadStore: InMemoryThreadStore, count: number): void {
    const recordTransition = threadStore.transition.bind(threadStore);
    let remaining = count;
    vi.spyOn(threadStore, "transition").mockImplementation(async (transition) => {
      if (transition.to.state === "running" && remaining > 0) {
        remaining -= 1;
        throw new Error("The control plane stopped before recording this");
      }
      return recordTransition(transition);
    });
  }

  async function takeOverLapsedOperations(clock: ControllableClock): Promise<void> {
    clock.advanceBy(testLifecycleSettings.checkIntervalInMilliseconds * 3);
    await controlPlane.threadServices.reconciler.reconcile({ includeSettledSandboxes: false });
    await controlPlane.whenOperationsSettle();
  }

  it("lets in the supervisor of a sandbox it made on an attempt that seemed to fail", async () => {
    const sandboxProvider = new FakeSandboxProvider();
    const createSandbox = sandboxProvider.create.bind(sandboxProvider);
    vi.spyOn(sandboxProvider, "create")
      .mockRejectedValueOnce(new Error("The control plane stopped before asking"))
      .mockImplementationOnce(async (request) => {
        await createSandbox(request);
        throw new SandboxProviderUnavailableError("create a sandbox", "the request timed out");
      });
    const threadStore = new InMemoryThreadStore();
    const clock = new ControllableClock();
    await start({ sandboxProvider, threadStore, clock: clock.now, retryDelaysInMilliseconds: [0] });
    vi.spyOn(threadStore, "transition").mockRejectedValueOnce(
      new Error("The control plane stopped before recording this"),
    );

    const { threadId } = await createThreadThroughApi();
    await controlPlane.whenOperationsSettle();
    await takeOverLapsedOperations(clock);

    expect((await fetchThread(threadId)).sandbox).toEqual({ state: "running" });
    expect(sandboxProvider.sandboxIds()).toHaveLength(1);
    expect(
      await acceptsSupervisorToken(threadId, controlPlane.supervisorTokenGivenFor(threadId)),
    ).toBe(true);
  });

  it("lets in the supervisor of the first attempt's sandbox when an earlier take-over was cut short too", async () => {
    const threadStore = new InMemoryThreadStore();
    const clock = new ControllableClock();
    await start({ threadStore, clock: clock.now });
    loseRecordsOfRunning(threadStore, 2);

    const { threadId } = await createThreadThroughApi();
    await controlPlane.whenOperationsSettle();
    const firstAttemptsToken = controlPlane.supervisorTokenGivenFor(threadId);
    await takeOverLapsedOperations(clock);
    await takeOverLapsedOperations(clock);

    expect((await fetchThread(threadId)).sandbox).toEqual({ state: "running" });
    expect(controlPlane.sandboxProvider.sandboxIds()).toHaveLength(1);
    expect(await acceptsSupervisorToken(threadId, firstAttemptsToken)).toBe(true);
    expect(await acceptsSupervisorToken(threadId, "a token nobody was given")).toBe(false);
  });
});

describe("the threads API", () => {
  it("refuses to create a thread for a request from another website with HTTP 403, even with a valid token", async () => {
    await start();

    const response = await controlPlane.postThread({
      ...browserHeaders(developmentAccessToken),
      Origin: "https://attacker.example",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden_origin" } });
    expect(controlPlane.sandboxProvider.calls).toEqual([]);
  });

  it("refuses to create a thread from a body not declared as JSON with HTTP 415, which a plain form cannot get round", async () => {
    await start();

    const response = await controlPlane.postThread({
      ...browserHeaders(developmentAccessToken),
      "Content-Type": "text/plain",
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: "unsupported_media_type" } });
    expect(controlPlane.sandboxProvider.calls).toEqual([]);
  });

  it.each([
    ["not JSON", "{"],
    ["not an empty object", '{"threadId":"chosen-by-the-client"}'],
  ])("refuses to create a thread from a body that is %s with HTTP 400", async (_, body) => {
    await start();

    const response = await controlPlane.postThread(browserHeaders(developmentAccessToken), body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(controlPlane.sandboxProvider.calls).toEqual([]);
  });

  it("answers HTTP 503, and asks for no sandbox, when the thread cannot be recorded", async () => {
    const threadStore = new InMemoryThreadStore();
    vi.spyOn(threadStore, "create").mockRejectedValue(new Error("The database went away"));
    await start({ threadStore });

    const response = await controlPlane.postThread();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } });
    expect(controlPlane.sandboxProvider.calls).toEqual([]);
  });

  it.each([
    ["does not exist", "thread-that-was-never-created"],
    ["is not a valid identifier", "not%20valid"],
  ])("answers HTTP 404 for a thread that %s", async (_, threadId) => {
    await start();

    const response = await controlPlane.getApi(`${threadsApiPath}/${threadId}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
