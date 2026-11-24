import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type NewThread,
  ThreadStateConflictError,
  type ThreadStore,
} from "../threads/thread-store.js";

/**
 * The behaviour every `ThreadStore` must have. Each implementation's test
 * file calls this with a function that creates a fresh, empty store, so the
 * in-memory store and the database-backed one are held to the same rules.
 */
export function describeThreadStoreContract(
  implementationName: string,
  createEmptyStore: () => Promise<ThreadStore>,
): void {
  describe(`${implementationName} as a thread store`, () => {
    it("records a new thread as creating its sandbox, stamped with when it was created", async () => {
      const store = await createEmptyStore();
      const thread = newThread("thread-a");
      const before = Date.now();

      const created = await store.create(thread);

      expect(created).toEqual({
        ...thread,
        createdAt: expect.any(Date),
        sandbox: { state: "creating" },
      });
      expect(created.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(created.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(await store.find("thread-a")).toEqual(created);
    });

    it("keeps the supervisor token digest byte for byte", async () => {
      const store = await createEmptyStore();
      const thread = newThread("thread-a");

      await store.create(thread);

      const found = await store.find("thread-a");
      expect(found?.supervisorTokenDigest.equals(thread.supervisorTokenDigest)).toBe(true);
    });

    it("refuses a second thread with the same identifier", async () => {
      const store = await createEmptyStore();
      await store.create(newThread("thread-a"));

      await expect(store.create(newThread("thread-a"))).rejects.toThrow();
    });

    it("finds nothing for a thread it does not hold", async () => {
      const store = await createEmptyStore();

      expect(await store.find("thread-a")).toBeUndefined();
    });

    it("records a created sandbox as ready, with its identifier", async () => {
      const store = await createEmptyStore();
      await store.create(newThread("thread-a"));

      await store.recordSandboxReady("thread-a", "sandbox-1");

      expect((await store.find("thread-a"))?.sandbox).toEqual({
        state: "ready",
        sandboxId: "sandbox-1",
      });
    });

    it("records why a sandbox could not be created", async () => {
      const store = await createEmptyStore();
      await store.create(newThread("thread-a"));

      await store.recordSandboxFailed("thread-a", "The provider has no quota left");

      expect((await store.find("thread-a"))?.sandbox).toEqual({
        state: "failed",
        reason: "The provider has no quota left",
      });
    });

    it("settles a sandbox only once, and only for a thread it holds", async () => {
      const store = await createEmptyStore();
      await store.create(newThread("thread-a"));
      await store.recordSandboxReady("thread-a", "sandbox-1");

      await expect(store.recordSandboxReady("thread-a", "sandbox-2")).rejects.toThrow(
        ThreadStateConflictError,
      );
      await expect(store.recordSandboxFailed("thread-a", "Too late")).rejects.toThrow(
        ThreadStateConflictError,
      );
      await expect(store.recordSandboxReady("thread-b", "sandbox-3")).rejects.toThrow(
        ThreadStateConflictError,
      );
      expect((await store.find("thread-a"))?.sandbox).toEqual({
        state: "ready",
        sandboxId: "sandbox-1",
      });
    });

    it("fails every sandbox still being created, and only those, and says which", async () => {
      const store = await createEmptyStore();
      for (const threadId of ["thread-a", "thread-b", "thread-c", "thread-d"]) {
        await store.create(newThread(threadId));
      }
      await store.recordSandboxReady("thread-b", "sandbox-1");
      await store.recordSandboxFailed("thread-c", "The provider has no quota left");

      const failedThreadIds = await store.failSandboxesStillBeingCreated("Interrupted");

      expect(failedThreadIds.toSorted()).toEqual(["thread-a", "thread-d"]);
      const sandboxes = (await store.listNewestFirst(10)).map(({ threadId, sandbox }) => ({
        threadId,
        sandbox,
      }));
      expect(sandboxes).toEqual([
        { threadId: "thread-d", sandbox: { state: "failed", reason: "Interrupted" } },
        {
          threadId: "thread-c",
          sandbox: { state: "failed", reason: "The provider has no quota left" },
        },
        { threadId: "thread-b", sandbox: { state: "ready", sandboxId: "sandbox-1" } },
        { threadId: "thread-a", sandbox: { state: "failed", reason: "Interrupted" } },
      ]);
      expect(await store.failSandboxesStillBeingCreated("Interrupted")).toEqual([]);
    });

    it("lists threads newest first, no more than asked for", async () => {
      const store = await createEmptyStore();
      for (const threadId of ["thread-a", "thread-b", "thread-c"]) {
        await store.create(newThread(threadId));
      }

      const newestTwo = await store.listNewestFirst(2);
      const all = await store.listNewestFirst(10);

      expect(newestTwo.map((thread) => thread.threadId)).toEqual(["thread-c", "thread-b"]);
      expect(all.map((thread) => thread.threadId)).toEqual(["thread-c", "thread-b", "thread-a"]);
    });

    it("hands out records that changing does not change the store", async () => {
      const store = await createEmptyStore();
      const created = await store.create(newThread("thread-a"));

      created.sandbox = { state: "ready", sandboxId: "forged" };
      created.supervisorTokenDigest.fill(0);

      const found = await store.find("thread-a");
      expect(found?.sandbox).toEqual({ state: "creating" });
      expect(found?.supervisorTokenDigest.equals(Buffer.alloc(32))).toBe(false);
    });
  });
}

function newThread(threadId: string): NewThread {
  return { threadId, sandboxProvider: "fake", supervisorTokenDigest: randomBytes(32) };
}
