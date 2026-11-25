import type { ProviderAccess } from "@barrack/protocol";
import type { OpenAiAccessAllowances } from "../chatgpt-plan/openai-access-allowances.js";
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
  readonly #openAiAccessAllowances: OpenAiAccessAllowances;

  constructor(
    threadStore: ThreadStore,
    relays: ModelAccessRefresher,
    allowances: {
      modelSwitches: ModelSwitchAllowances;
      openAiAccess: OpenAiAccessAllowances;
    },
  ) {
    this.#threadStore = threadStore;
    this.#relays = relays;
    this.#modelSwitchAllowances = allowances.modelSwitches;
    this.#openAiAccessAllowances = allowances.openAiAccess;
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

  /**
   * Before the owner's OpenAI access may change from `currentAccess`
   * (connecting a plan, choosing the key or the plan, disconnecting): each
   * of their threads with a run open keeps what the run began with, so the
   * model proxy goes on spending it for that run (see
   * `OpenAiAccessAllowances`). Only threads whose sandbox runs can have a
   * run open.
   */
  async openAiAccessMayChange(ownerUserId: string, currentAccess: ProviderAccess): Promise<void> {
    for (const thread of await this.#listToldAtOnce(ownerUserId)) {
      if (thread.sandbox.state === "running") {
        await this.#openAiAccessAllowances.noteBeforeChange(thread.threadId, currentAccess);
      }
    }
  }

  async ownerCredentialsChanged(ownerUserId: string): Promise<void> {
    for (const thread of await this.#listToldAtOnce(ownerUserId)) {
      this.#relays.refreshModelAccess(thread.threadId);
    }
  }

  #listToldAtOnce(ownerUserId: string): Promise<ThreadRecord[]> {
    return this.#threadStore.listMostRecentlyActiveOwnedBy(ownerUserId, threadsToldAtOnce);
  }
}

/** As many as the thread list shows; a user with more is told lazily. */
const threadsToldAtOnce = 100;
