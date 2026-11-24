import type { ThreadRecord, ThreadStore } from "../threads/thread-store.js";

/**
 * Records a thread with its sandbox being created, for tests that need a
 * thread to exist but not its sandbox.
 */
export async function recordTestThread(
  threadStore: ThreadStore,
  thread: { threadId: string; ownerUserId: string },
  now: Date = new Date(),
): Promise<ThreadRecord> {
  const outcome = await threadStore.create(
    { ...thread, sandboxProvider: "fake", supervisorTokenDigest: Buffer.alloc(32) },
    {
      at: now,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      admission: { maximumPerUser: Number.MAX_SAFE_INTEGER, maximumInInstallation: undefined },
    },
  );
  if (outcome.kind !== "changed") {
    throw new Error(`Could not record the test thread ${thread.threadId}`);
  }
  return outcome.thread;
}
