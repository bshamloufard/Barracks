import type { ThreadStore } from "../threads/thread-store.js";

/** Where a changed key or model is passed on: each thread's relay. */
export type ModelAccessRefresher = { refreshModelAccess(threadId: string): void };

/**
 * Passes a change of a user's keys, or of a thread's model, on to the
 * supervisors attached here, so a replaced key is used and a removed one
 * withdrawn at once. Only the user's most recently active threads are
 * told; any other is told before its next user message reaches its agent
 * (see `ThreadRelay`), as is one whose supervisor is attached to another
 * control plane instance during a redeploy.
 */
export class ModelAccessChanges {
  readonly #threadStore: ThreadStore;
  readonly #relays: ModelAccessRefresher;

  constructor(threadStore: ThreadStore, relays: ModelAccessRefresher) {
    this.#threadStore = threadStore;
    this.#relays = relays;
  }

  threadModelChanged(threadId: string): void {
    this.#relays.refreshModelAccess(threadId);
  }

  async ownerCredentialsChanged(ownerUserId: string): Promise<void> {
    const threads = await this.#threadStore.listMostRecentlyActiveOwnedBy(
      ownerUserId,
      threadsToldAtOnce,
    );
    for (const thread of threads) {
      this.#relays.refreshModelAccess(thread.threadId);
    }
  }
}

/** As many as the thread list shows; a user with more is told lazily. */
const threadsToldAtOnce = 100;
