import type {
  NewThreadRepository,
  RepositoryPublication,
  ThreadRepositoryRecord,
  ThreadRepositoryStore,
} from "./thread-repository-store.js";

/**
 * Keeps threads' repositories in memory, for development and tests. The
 * in-memory thread store records and forgets a thread's repository here as
 * it records and removes the thread.
 */
export class InMemoryThreadRepositoryStore implements ThreadRepositoryStore {
  readonly #records = new Map<string, ThreadRepositoryRecord>();

  /** Called by the in-memory thread store as it records the thread. */
  recordNewThread(threadId: string, repository: NewThreadRepository): void {
    this.#records.set(threadId, {
      ...repository,
      threadId,
      lastPublishedCommit: undefined,
      pullRequest: undefined,
    });
  }

  /** Called by the in-memory thread store as it removes the thread. */
  forgetThread(threadId: string): void {
    this.#records.delete(threadId);
  }

  async find(threadId: string): Promise<ThreadRepositoryRecord | undefined> {
    const record = this.#records.get(threadId);
    return record === undefined ? undefined : structuredClone(record);
  }

  async findMany(threadIds: readonly string[]): Promise<Map<string, ThreadRepositoryRecord>> {
    const found = new Map<string, ThreadRepositoryRecord>();
    for (const threadId of threadIds) {
      const record = this.#records.get(threadId);
      if (record !== undefined) {
        found.set(threadId, structuredClone(record));
      }
    }
    return found;
  }

  async recordPublication(threadId: string, publication: RepositoryPublication): Promise<void> {
    const record = this.#records.get(threadId);
    if (record !== undefined) {
      this.#records.set(threadId, {
        ...record,
        lastPublishedCommit: publication.lastPublishedCommit,
        pullRequest: record.pullRequest ?? publication.pullRequest,
      });
    }
  }
}
