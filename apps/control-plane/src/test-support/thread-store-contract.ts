import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IllegalSandboxTransitionError,
  legalSandboxTransitions,
  type NewThread,
  type SandboxAdmission,
  type SandboxState,
  sandboxStates,
  type ThreadRecord,
  type ThreadSandboxRecord,
  type ThreadStore,
} from "../threads/thread-store.js";

/**
 * The users whose threads the contract creates. A store that checks that a
 * thread's owner is a recorded user must have these recorded before the
 * contract runs.
 */
export const contractOwnerUserIds = ["user-a", "user-b"] as const;

const [ownerA, ownerB] = contractOwnerUserIds;

const generousAdmission: SandboxAdmission = {
  maximumPerUser: 100,
  maximumInInstallation: undefined,
};

/** A fixed moment, so recorded times can be compared exactly; later ones are offsets from it. */
const startTime = new Date("2026-11-24T09:00:00.000Z");

function secondsAfterStart(seconds: number): Date {
  return new Date(startTime.getTime() + seconds * 1000);
}

/** An example of each state, as the change to it would ask for. */
function exampleSandbox(state: SandboxState): ThreadSandboxRecord {
  const leaseExpiresAt = secondsAfterStart(60);
  switch (state) {
    case "creating":
      return { state, leaseExpiresAt };
    case "running":
    case "stopped":
      return { state, sandboxId: "sandbox-1", problem: undefined };
    case "stopping":
    case "starting":
      return { state, sandboxId: "sandbox-1", leaseExpiresAt };
    case "failed":
      return { state, sandboxId: "sandbox-1", reason: "It broke." };
    case "deleting":
      return { state, sandboxId: "sandbox-1", leaseExpiresAt };
  }
}

/** The legal route from a new thread to each state. */
const routeTo: Record<SandboxState, SandboxState[]> = {
  creating: [],
  running: ["running"],
  stopping: ["running", "stopping"],
  stopped: ["running", "stopping", "stopped"],
  starting: ["running", "stopping", "stopped", "starting"],
  failed: ["running", "failed"],
  deleting: ["running", "deleting"],
};

/**
 * The behaviour every `ThreadStore` must have. Each implementation's test
 * file calls this with a function that creates a fresh, empty store, so the
 * in-memory store and the database-backed one are held to the same rules.
 */
export function describeThreadStoreContract(
  implementationName: string,
  createEmptyStore: () => Promise<ThreadStore>,
): void {
  async function createThread(
    store: ThreadStore,
    threadId: string,
    owner: string = ownerA,
    at: Date = startTime,
  ): Promise<ThreadRecord> {
    const outcome = await store.create(newThread(threadId, owner), {
      at,
      leaseExpiresAt: secondsAfterStart(60),
      admission: generousAdmission,
    });
    if (outcome.kind !== "changed") {
      throw new Error(`Could not create ${threadId}`);
    }
    return outcome.thread;
  }

  async function changeTo(
    store: ThreadStore,
    thread: ThreadRecord,
    state: SandboxState,
    at: Date = startTime,
  ): Promise<ThreadRecord> {
    const outcome = await store.transition({
      threadId: thread.threadId,
      fromVersion: thread.version,
      to: exampleSandbox(state),
      at,
    });
    if (outcome.kind !== "changed") {
      throw new Error(`Could not move ${thread.threadId} to ${state}: ${outcome.kind}`);
    }
    return outcome.thread;
  }

  async function threadOrThrow(store: ThreadStore, threadId: string): Promise<ThreadRecord> {
    const thread = await store.find(threadId);
    if (thread === undefined) {
      throw new Error(`There is no ${threadId}`);
    }
    return thread;
  }

  async function threadIn(
    store: ThreadStore,
    state: SandboxState,
    threadId = `thread-${state}`,
    owner: string = ownerA,
  ): Promise<ThreadRecord> {
    let thread = await createThread(store, threadId, owner);
    for (const step of routeTo[state]) {
      thread = await changeTo(store, thread, step);
    }
    return thread;
  }

  describe(`${implementationName} as a thread store`, () => {
    it("records a new thread as creating its sandbox, created and last active when it says, with no title", async () => {
      const store = await createEmptyStore();
      const thread = newThread("thread-a", ownerA);

      const created = await createThread(store, "thread-a");

      const { supervisorTokenDigest: _digest, ...threadWithoutDigest } = thread;
      expect(created).toEqual({
        ...threadWithoutDigest,
        supervisorTokenDigests: [expect.any(Buffer)],
        createdAt: startTime,
        lastActivityAt: startTime,
        sandbox: { state: "creating", leaseExpiresAt: secondsAfterStart(60) },
        version: 1,
        title: undefined,
        isWakeRequested: false,
        awaitingSupervisorSince: startTime,
      });
      expect(await store.find("thread-a")).toEqual(created);
    });

    it("keeps the supervisor token digests byte for byte, and adds one only when told, keeping the earlier", async () => {
      const store = await createEmptyStore();
      const created = await createThread(store, "thread-a");
      const [firstDigest] = created.supervisorTokenDigests;
      const addedDigest = randomBytes(32);

      await store.transition({
        threadId: "thread-a",
        fromVersion: created.version,
        to: exampleSandbox("running"),
        at: startTime,
        addedSupervisorTokenDigest: addedDigest,
      });
      const running = await store.find("thread-a");
      const stopping =
        running === undefined ? undefined : await changeTo(store, running, "stopping");

      expect(created.supervisorTokenDigests).toHaveLength(1);
      expect(running?.supervisorTokenDigests).toEqual([firstDigest, addedDigest]);
      expect(stopping?.supervisorTokenDigests).toEqual([firstDigest, addedDigest]);
    });

    it("refuses a second thread with the same identifier", async () => {
      const store = await createEmptyStore();
      await createThread(store, "thread-a");

      await expect(createThread(store, "thread-a")).rejects.toThrow();
    });

    it("finds a thread only for its owner, and anyone's thread for the control plane", async () => {
      const store = await createEmptyStore();
      await createThread(store, "thread-a", ownerA);

      expect(await store.findOwnedBy(ownerA, "thread-a")).toMatchObject({ threadId: "thread-a" });
      expect(await store.findOwnedBy(ownerB, "thread-a")).toBeUndefined();
      expect(await store.findOwnedBy(ownerA, "thread-missing")).toBeUndefined();
      expect(await store.find("thread-a")).toMatchObject({ ownerUserId: ownerA });
      expect(await store.find("thread-missing")).toBeUndefined();
    });

    it("switches a thread's model for its owner alone, leaving its version as it was", async () => {
      const store = await createEmptyStore();
      const created = await createThread(store, "thread-a", ownerA);

      expect(await store.changeModel(ownerB, "thread-a", "openai/other-model")).toBeUndefined();
      expect(
        await store.changeModel(ownerA, "thread-missing", "openai/other-model"),
      ).toBeUndefined();
      const changed = await store.changeModel(ownerA, "thread-a", "openai/other-model");

      expect(changed).toEqual({ ...created, model: "openai/other-model" });
      expect(await store.find("thread-a")).toEqual(changed);
    });

    it("lists only the owner's threads, the most recently active first, up to the limit", async () => {
      const store = await createEmptyStore();
      await createThread(store, "thread-1", ownerA, secondsAfterStart(1));
      await createThread(store, "thread-2", ownerA, secondsAfterStart(2));
      await createThread(store, "thread-3", ownerA, secondsAfterStart(3));
      await createThread(store, "thread-b", ownerB, secondsAfterStart(4));
      await store.recordActivity("thread-1", secondsAfterStart(10));

      const listed = await store.listMostRecentlyActiveOwnedBy(ownerA, 2);

      expect(listed.map((thread) => thread.threadId)).toEqual(["thread-1", "thread-3"]);
      expect(await store.listMostRecentlyActiveOwnedBy("user-without-threads", 10)).toEqual([]);
    });
  });

  describe(`${implementationName}'s sandbox state changes`, () => {
    const legalChanges = sandboxStates.flatMap((from) =>
      legalSandboxTransitions[from].map((to) => ({ from, to })),
    );
    const illegalChanges = sandboxStates.flatMap((from) =>
      sandboxStates
        .filter((to) => !legalSandboxTransitions[from].includes(to))
        .map((to) => ({ from, to })),
    );

    it.each(legalChanges)(
      "allows $from to become $to, moving the version on",
      async ({ from, to }) => {
        const store = await createEmptyStore();
        const thread = await threadIn(store, from);

        const outcome = await store.transition({
          threadId: thread.threadId,
          fromVersion: thread.version,
          to: exampleSandbox(to),
          at: secondsAfterStart(5),
        });

        expect(outcome).toEqual({
          kind: "changed",
          thread: expect.objectContaining({
            sandbox: exampleSandbox(to),
            version: thread.version + 1,
          }),
        });
        expect(await store.find(thread.threadId)).toEqual(
          outcome.kind === "changed" ? outcome.thread : undefined,
        );
      },
    );

    it.each(illegalChanges)(
      "refuses to let $from become $to, and changes nothing",
      async ({ from, to }) => {
        const store = await createEmptyStore();
        const thread = await threadIn(store, from);

        const change = store.transition({
          threadId: thread.threadId,
          fromVersion: thread.version,
          to: exampleSandbox(to),
          at: secondsAfterStart(5),
        });

        await expect(change).rejects.toThrow(IllegalSandboxTransitionError);
        expect(await store.find(thread.threadId)).toEqual(thread);
      },
    );

    it("makes no change from a version the thread has moved past, or to a thread that does not exist", async () => {
      const store = await createEmptyStore();
      const created = await createThread(store, "thread-a");
      await changeTo(store, created, "running");

      const stale = await store.transition({
        threadId: "thread-a",
        fromVersion: created.version,
        to: exampleSandbox("failed"),
        at: startTime,
      });
      const missing = await store.transition({
        threadId: "thread-missing",
        fromVersion: 1,
        to: exampleSandbox("running"),
        at: startTime,
      });

      expect(stale).toEqual({ kind: "conflict" });
      expect(missing).toEqual({ kind: "conflict" });
      expect((await store.find("thread-a"))?.sandbox.state).toBe("running");
    });

    it("lets exactly one of two changes from the same reading through", async () => {
      const store = await createEmptyStore();
      const running = await threadIn(store, "running", "thread-a");
      const stopFrom = (reading: ThreadRecord) =>
        store.transition({
          threadId: "thread-a",
          fromVersion: reading.version,
          to: exampleSandbox("stopping"),
          at: startTime,
        });

      const outcomes = await Promise.all([stopFrom(running), stopFrom(running)]);

      expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["changed", "conflict"]);
      expect((await store.find("thread-a"))?.version).toBe(running.version + 1);
    });

    it("records a sandbox becoming running as activity, and no other change", async () => {
      const store = await createEmptyStore();
      const created = await createThread(store, "thread-a");

      const running = await changeTo(store, created, "running", secondsAfterStart(30));
      const stopping = await changeTo(store, running, "stopping", secondsAfterStart(40));

      expect(running.lastActivityAt).toEqual(secondsAfterStart(30));
      expect(stopping.lastActivityAt).toEqual(secondsAfterStart(30));
    });

    it("makes an idle shutdown's change only if nothing was active since it read the thread", async () => {
      const store = await createEmptyStore();
      const running = await threadIn(store, "running", "thread-a");
      const idleStopOf = (reading: ThreadRecord) =>
        store.transition({
          threadId: "thread-a",
          fromVersion: reading.version,
          to: exampleSandbox("stopping"),
          at: secondsAfterStart(100),
          onlyIfLastActiveAt: reading.lastActivityAt,
        });

      await store.recordActivity("thread-a", secondsAfterStart(50));
      const afterActivity = await idleStopOf(running);
      const reread = await store.find("thread-a");
      const afterRereading = reread === undefined ? undefined : await idleStopOf(reread);

      expect(afterActivity).toEqual({ kind: "conflict" });
      expect(afterRereading?.kind).toBe("changed");
    });

    it("extends the lease of an operation only while the thread is at the version that holds it", async () => {
      const store = await createEmptyStore();
      const stopping = await threadIn(store, "stopping", "thread-a");

      const renewed = await store.renewLease("thread-a", stopping.version, secondsAfterStart(500));
      const leaseAfterRenewal = (await store.find("thread-a"))?.sandbox;
      await changeTo(store, stopping, "stopping");
      const renewedAfterTakeover = await store.renewLease(
        "thread-a",
        stopping.version,
        secondsAfterStart(900),
      );

      expect(renewed).toBe(true);
      expect(leaseAfterRenewal).toMatchObject({ leaseExpiresAt: secondsAfterStart(500) });
      expect(renewedAfterTakeover).toBe(false);
      expect(await store.renewLease("thread-missing", 1, secondsAfterStart(1))).toBe(false);
    });

    it("removes a thread only while it is being deleted, at the version read", async () => {
      const store = await createEmptyStore();
      const deleting = await threadIn(store, "deleting", "thread-a");
      const running = await threadIn(store, "running", "thread-b");

      expect(await store.remove("thread-a", deleting.version - 1)).toBe(false);
      expect(await store.remove("thread-b", running.version)).toBe(false);
      expect(await store.remove("thread-a", deleting.version)).toBe(true);
      expect(await store.find("thread-a")).toBeUndefined();
      expect(await store.find("thread-b")).toBeDefined();
    });
  });

  describe(`${implementationName} on user messages and waking`, () => {
    it("records a user message's arrival as activity, and takes the first message's title only", async () => {
      const store = await createEmptyStore();
      const created = await createThread(store, "thread-a");

      const first = await store.recordUserMessageArrival("thread-a", {
        at: secondsAfterStart(10),
        title: "Fix the build",
      });
      const second = await store.recordUserMessageArrival("thread-a", {
        at: secondsAfterStart(20),
        title: "Something else",
      });

      expect(first).toMatchObject({
        title: "Fix the build",
        lastActivityAt: secondsAfterStart(10),
      });
      expect(second).toMatchObject({
        title: "Fix the build",
        lastActivityAt: secondsAfterStart(20),
      });
      expect(second?.version).toBe(created.version);
      expect(
        await store.recordUserMessageArrival("thread-missing", { at: startTime, title: "x" }),
      ).toBeUndefined();
    });

    it("asks a stopping sandbox to wake, which ends its stop as starting instead of stopped", async () => {
      const store = await createEmptyStore();
      const stopping = await threadIn(store, "stopping", "thread-a");
      const plainStop = await threadIn(store, "stopping", "thread-b");

      const arrival = await store.recordUserMessageArrival("thread-a", {
        at: secondsAfterStart(10),
        title: undefined,
      });
      const woken = await store.finishStopping({
        threadId: "thread-a",
        fromVersion: stopping.version,
        wakeLeaseExpiresAt: secondsAfterStart(70),
        at: secondsAfterStart(70),
      });
      const stopped = await store.finishStopping({
        threadId: "thread-b",
        fromVersion: plainStop.version,
        wakeLeaseExpiresAt: secondsAfterStart(70),
        at: secondsAfterStart(70),
      });

      expect(arrival).toMatchObject({ isWakeRequested: true, version: stopping.version });
      expect(woken).toEqual({
        kind: "changed",
        thread: expect.objectContaining({
          sandbox: {
            state: "starting",
            sandboxId: "sandbox-1",
            leaseExpiresAt: secondsAfterStart(70),
          },
          isWakeRequested: false,
        }),
      });
      expect(stopped).toEqual({
        kind: "changed",
        thread: expect.objectContaining({
          sandbox: { state: "stopped", sandboxId: "sandbox-1", problem: undefined },
        }),
      });
    });

    it("keeps a wake request when a stop is taken over, and asks no wake of a sandbox not stopping", async () => {
      const store = await createEmptyStore();
      const stopping = await threadIn(store, "stopping", "thread-a");
      await threadIn(store, "running", "thread-b");
      await store.recordUserMessageArrival("thread-a", { at: startTime, title: undefined });
      await store.recordUserMessageArrival("thread-b", { at: startTime, title: undefined });

      const takenOver = await changeTo(store, stopping, "stopping");

      expect(takenOver.isWakeRequested).toBe(true);
      expect((await store.find("thread-b"))?.isWakeRequested).toBe(false);
    });

    it("finishes a stop only from the version that is stopping", async () => {
      const store = await createEmptyStore();
      const stopping = await threadIn(store, "stopping", "thread-a");

      const stale = await store.finishStopping({
        threadId: "thread-a",
        fromVersion: stopping.version - 1,
        wakeLeaseExpiresAt: startTime,
        at: startTime,
      });

      expect(stale).toEqual({ kind: "conflict" });
    });

    it("has a sandbox await its supervisor from when it is asked for, and again from when it runs", async () => {
      const store = await createEmptyStore();
      const created = await createThread(store, "thread-a");

      const running = await changeTo(store, created, "running", secondsAfterStart(30));
      await store.recordSupervisorAttached("thread-a", secondsAfterStart(40));
      const attached = await store.find("thread-a");
      const stopped = await changeTo(store, await threadOrThrow(store, "thread-a"), "stopped");
      const starting = await changeTo(store, stopped, "starting", secondsAfterStart(90));

      expect(created.awaitingSupervisorSince).toEqual(startTime);
      expect(running.awaitingSupervisorSince).toEqual(secondsAfterStart(30));
      expect(attached?.awaitingSupervisorSince).toBeUndefined();
      expect(attached?.version).toBe(running.version);
      expect(stopped.awaitingSupervisorSince).toBeUndefined();
      expect(starting.awaitingSupervisorSince).toEqual(secondsAfterStart(90));
    });

    it("records a thread active when its awaited supervisor attaches, and not when one attaches again", async () => {
      const store = await createEmptyStore();
      const created = await createThread(store, "thread-a");
      await changeTo(store, created, "running", secondsAfterStart(30));

      await store.recordSupervisorAttached("thread-a", secondsAfterStart(50));
      const attached = await threadOrThrow(store, "thread-a");
      await store.recordSupervisorAttached("thread-a", secondsAfterStart(90));

      expect(attached.lastActivityAt).toEqual(secondsAfterStart(50));
      expect((await threadOrThrow(store, "thread-a")).lastActivityAt).toEqual(
        secondsAfterStart(50),
      );
    });

    it("fails a sandbox for want of its supervisor only if it still awaits it since the time read", async () => {
      const store = await createEmptyStore();
      const created = await createThread(store, "thread-a");
      const running = await changeTo(store, created, "running", secondsAfterStart(30));
      const stopForWantOfSupervisor = () =>
        store.transition({
          threadId: "thread-a",
          fromVersion: running.version,
          to: exampleSandbox("stopping"),
          at: secondsAfterStart(400),
          onlyIfAwaitingSupervisorSince: secondsAfterStart(30),
        });

      await store.recordSupervisorAttached("thread-a", secondsAfterStart(35));
      const afterAttaching = await stopForWantOfSupervisor();

      expect(afterAttaching).toEqual({ kind: "conflict" });
      expect((await threadOrThrow(store, "thread-a")).sandbox.state).toBe("running");
    });

    it("fails a sandbox for want of its supervisor while it still awaits it", async () => {
      const store = await createEmptyStore();
      const created = await createThread(store, "thread-a");
      const running = await changeTo(store, created, "running", secondsAfterStart(30));

      const outcome = await store.transition({
        threadId: "thread-a",
        fromVersion: running.version,
        to: exampleSandbox("stopping"),
        at: secondsAfterStart(400),
        onlyIfAwaitingSupervisorSince: secondsAfterStart(30),
      });

      expect(outcome.kind).toBe("changed");
    });

    it("does not await a supervisor that attached before its sandbox was recorded running", async () => {
      const store = await createEmptyStore();
      const created = await createThread(store, "thread-a");

      await store.recordSupervisorAttached("thread-a", secondsAfterStart(35));
      const running = await changeTo(store, created, "running", secondsAfterStart(30));

      expect(running.awaitingSupervisorSince).toBeUndefined();
    });

    it("has a sandbox woken as it stops await its supervisor from then", async () => {
      const store = await createEmptyStore();
      const stopping = await threadIn(store, "stopping", "thread-a");
      await store.recordSupervisorAttached("thread-a", secondsAfterStart(35));
      await store.recordUserMessageArrival("thread-a", { at: startTime, title: undefined });

      const woken = await store.finishStopping({
        threadId: "thread-a",
        fromVersion: stopping.version,
        wakeLeaseExpiresAt: secondsAfterStart(70),
        at: secondsAfterStart(40),
      });

      expect(woken).toMatchObject({
        kind: "changed",
        thread: { awaitingSupervisorSince: secondsAfterStart(40) },
      });
    });
  });

  describe(`${implementationName}'s limit on running sandboxes`, () => {
    it("refuses a new thread once its owner has as many sandboxes taking a place as allowed, naming them", async () => {
      const store = await createEmptyStore();
      await threadIn(store, "running", "thread-running");
      await threadIn(store, "creating", "thread-creating");
      await threadIn(store, "stopped", "thread-stopped");
      await threadIn(store, "failed", "thread-failed");
      await threadIn(store, "running", "thread-of-b", ownerB);
      await store.recordActivity("thread-creating", secondsAfterStart(100));
      const admission = { maximumPerUser: 2, maximumInInstallation: undefined };

      const refused = await store.create(newThread("thread-new", ownerA), {
        at: startTime,
        leaseExpiresAt: startTime,
        admission,
      });
      const admittedForB = await store.create(newThread("thread-new-b", ownerB), {
        at: startTime,
        leaseExpiresAt: startTime,
        admission,
      });

      expect(refused).toMatchObject({ kind: "limit_reached", limit: "per_user", maximum: 2 });
      expect(
        refused.kind === "limit_reached" && refused.occupying.map((thread) => thread.threadId),
      ).toEqual(["thread-creating", "thread-running"]);
      expect(admittedForB.kind).toBe("changed");
      expect(await store.find("thread-new")).toBeUndefined();
    });

    it("counts a thread being deleted while it still has a sandbox, and not once it has none", async () => {
      const store = await createEmptyStore();
      await threadIn(store, "deleting", "thread-deleting-with-sandbox");
      const failed = await threadIn(store, "failed", "thread-deleting-without-sandbox");
      const lost = await store.transition({
        threadId: failed.threadId,
        fromVersion: failed.version,
        to: { state: "failed", sandboxId: undefined, reason: "Gone." },
        at: startTime,
      });
      await store.transition({
        threadId: failed.threadId,
        fromVersion: lost.kind === "changed" ? lost.thread.version : 0,
        to: { state: "deleting", sandboxId: undefined, leaseExpiresAt: startTime },
        at: startTime,
      });
      const admission = { maximumPerUser: 1, maximumInInstallation: undefined };

      const refused = await store.create(newThread("thread-new", ownerA), {
        at: startTime,
        leaseExpiresAt: startTime,
        admission,
      });

      expect(
        refused.kind === "limit_reached" && refused.occupying.map((thread) => thread.threadId),
      ).toEqual(["thread-deleting-with-sandbox"]);
    });

    it("refuses anyone once the installation's limit is reached", async () => {
      const store = await createEmptyStore();
      await threadIn(store, "running", "thread-of-b", ownerB);

      const refused = await store.create(newThread("thread-new", ownerA), {
        at: startTime,
        leaseExpiresAt: startTime,
        admission: { maximumPerUser: 5, maximumInInstallation: 1 },
      });

      expect(refused).toEqual({
        kind: "limit_reached",
        limit: "installation",
        maximum: 1,
        occupying: [],
      });
    });

    it("refuses to start a stopped sandbox at the limit, not counting the sandbox itself", async () => {
      const store = await createEmptyStore();
      const stopped = await threadIn(store, "stopped", "thread-a");
      const startFor = (maximumPerUser: number) =>
        store.transition({
          threadId: "thread-a",
          fromVersion: stopped.version,
          to: exampleSandbox("starting"),
          at: startTime,
          admission: { maximumPerUser, maximumInInstallation: undefined },
        });
      await threadIn(store, "running", "thread-b");

      const refused = await startFor(1);
      const admitted = await startFor(2);

      expect(refused).toMatchObject({ kind: "limit_reached", limit: "per_user" });
      expect(admitted.kind).toBe("changed");
    });

    it("admits exactly as many of several threads created at once as there are places", async () => {
      const store = await createEmptyStore();
      const admission = { maximumPerUser: 2, maximumInInstallation: undefined };

      const outcomes = await Promise.all(
        ["thread-1", "thread-2", "thread-3", "thread-4"].map((threadId) =>
          store.create(newThread(threadId, ownerA), {
            at: startTime,
            leaseExpiresAt: startTime,
            admission,
          }),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.kind === "changed")).toHaveLength(2);
    });
  });

  describe(`${implementationName}'s lists for the control plane's sweeps`, () => {
    it("lists the threads in given states, whoever owns them", async () => {
      const store = await createEmptyStore();
      await threadIn(store, "running", "thread-running");
      await threadIn(store, "stopping", "thread-stopping", ownerB);
      await threadIn(store, "stopped", "thread-stopped");

      const listed = await store.listInStates(["running", "stopping"], 10);

      expect(listed.map((thread) => thread.threadId).sort()).toEqual([
        "thread-running",
        "thread-stopping",
      ]);
    });

    it("lists running sandboxes with no activity since a moment, and no others", async () => {
      const store = await createEmptyStore();
      await threadIn(store, "running", "thread-idle");
      await threadIn(store, "running", "thread-busy");
      await threadIn(store, "stopped", "thread-stopped");
      await store.recordActivity("thread-busy", secondsAfterStart(100));

      const idle = await store.listRunningInactiveSince(secondsAfterStart(50), 10);

      expect(idle.map((thread) => thread.threadId)).toEqual(["thread-idle"]);
    });
  });
}

function newThread(threadId: string, ownerUserId: string): NewThread {
  return {
    threadId,
    ownerUserId,
    sandboxProvider: "fake",
    supervisorTokenDigest: randomBytes(32),
    model: "anthropic/example-model",
  };
}
