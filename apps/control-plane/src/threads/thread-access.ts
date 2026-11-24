import type { ThreadStore } from "./thread-store.js";

/**
 * Proof that a user's ownership of a thread has been checked. A client can
 * only be attached to a thread's relay with one (`ThreadRelayRegistry`), and
 * the only way to get one is `ThreadAccess.check`, so a new way of
 * connecting clients cannot skip the check by accident.
 */
export class ThreadAccess {
  readonly threadId: string;
  readonly userId: string;

  private constructor(threadId: string, userId: string) {
    this.threadId = threadId;
    this.userId = userId;
  }

  /**
   * Access if the thread exists and belongs to the user; undefined
   * otherwise, the same whether it does not exist or is someone else's.
   */
  static async check(
    threadStore: ThreadStore,
    userId: string,
    threadId: string,
  ): Promise<ThreadAccess | undefined> {
    const thread = await threadStore.findOwnedBy(userId, threadId);
    return thread === undefined ? undefined : new ThreadAccess(threadId, userId);
  }
}
