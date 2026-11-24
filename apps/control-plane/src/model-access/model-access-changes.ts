import type { ModelSwitchAllowances } from "../model-proxy/model-switch-allowances.js";
import type { ThreadRecord, ThreadStore } from "../threads/thread-store.js";

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
  readonly #modelSwitchAllowances: ModelSwitchAllowances;

  constructor(
    threadStore: ThreadStore,
    relays: ModelAccessRefresher,
    modelSwitchAllowances: ModelSwitchAllowances,
  ) {
    this.#threadStore = threadStore;
    this.#relays = relays;
    this.#modelSwitchAllowances = modelSwitchAllowances;
  }

  /**
   * Switches the owner's thread from `previousModel` (as just read) to
   * `model`, which applies from the agent's next run. The model proxy is
   * told first, so the run in progress keeps its model without a gap and
   * every other provider's tokens are retired; then the thread's record;
   * then its supervisor. Undefined if the thread is not the owner's.
   */
  async switchThreadModel(
    ownerUserId: string,
    threadId: string,
    previousModel: string | undefined,
    model: string,
  ): Promise<ThreadRecord | undefined> {
    await this.#modelSwitchAllowances.noteSwitch(threadId, previousModel, model);
    const thread = await this.#threadStore.changeModel(ownerUserId, threadId, model);
    if (thread !== undefined) {
      this.#relays.refreshModelAccess(threadId);
    }
    return thread;
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
