import {
  type NewThread,
  type ThreadRecord,
  type ThreadSandboxRecord,
  ThreadStateConflictError,
  type ThreadStore,
} from "./thread-store.js";

/**
 * Keeps thread records in process memory, for local development and tests.
 * Every thread is forgotten when the process exits.
 */
export class InMemoryThreadStore implements ThreadStore {
  /** In order of creation, so the newest is last even when two share a millisecond. */
  readonly #threads: ThreadRecord[] = [];

  async create(thread: NewThread): Promise<ThreadRecord> {
    if (this.#find(thread.threadId) !== undefined) {
      throw new Error(`A thread "${thread.threadId}" already exists`);
    }
    const record: ThreadRecord = {
      ...thread,
      supervisorTokenDigest: Buffer.from(thread.supervisorTokenDigest),
      createdAt: new Date(),
      sandbox: { state: "creating" },
    };
    this.#threads.push(record);
    return copyOf(record);
  }

  async recordSandboxReady(threadId: string, sandboxId: string): Promise<void> {
    this.#changeCreatingSandbox(threadId, "record its sandbox", { state: "ready", sandboxId });
  }

  async recordSandboxFailed(threadId: string, reason: string): Promise<void> {
    this.#changeCreatingSandbox(threadId, "record its sandbox's failure", {
      state: "failed",
      reason,
    });
  }

  async failSandboxesStillBeingCreated(reason: string): Promise<string[]> {
    const creatingThreads = this.#threads.filter((record) => record.sandbox.state === "creating");
    for (const record of creatingThreads) {
      record.sandbox = { state: "failed", reason };
    }
    return creatingThreads.map((record) => record.threadId);
  }

  async find(threadId: string): Promise<ThreadRecord | undefined> {
    const record = this.#find(threadId);
    return record === undefined ? undefined : copyOf(record);
  }

  async listNewestFirst(limit: number): Promise<ThreadRecord[]> {
    return this.#threads.toReversed().slice(0, limit).map(copyOf);
  }

  #changeCreatingSandbox(
    threadId: string,
    attemptedChange: string,
    sandbox: ThreadSandboxRecord,
  ): void {
    const record = this.#find(threadId);
    if (record?.sandbox.state !== "creating") {
      throw new ThreadStateConflictError(threadId, attemptedChange);
    }
    record.sandbox = sandbox;
  }

  #find(threadId: string): ThreadRecord | undefined {
    return this.#threads.find((record) => record.threadId === threadId);
  }
}

/** Callers get copies, as they would from a database, so they cannot change the store's records. */
function copyOf(record: ThreadRecord): ThreadRecord {
  return {
    ...record,
    supervisorTokenDigest: Buffer.from(record.supervisorTokenDigest),
    createdAt: new Date(record.createdAt),
    sandbox: { ...record.sandbox },
  };
}
