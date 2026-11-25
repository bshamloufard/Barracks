import type { ProviderAccess } from "@barrack/protocol";
import { previousModelAllowedForInMilliseconds } from "../model-proxy/model-switch-allowances.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type { OpenAiAccessAllowanceStore } from "./openai-access-allowance-store.js";

export type OpenAiAccessAllowancesOptions = {
  store: OpenAiAccessAllowanceStore;
  threadEventLog: ThreadEventLog;
  clock?: () => Date;
};

/**
 * What a thread's run spends on OpenAI models when its owner changed that
 * while the run was open: what the run began with, for that run alone and
 * for at most as long as the model before a switch
 * (`previousModelAllowedForInMilliseconds`, whose reasons apply here too).
 * The agent shapes its OpenAI requests for the key or for the plan (see
 * `pi-credential-file.ts` in the supervisor) and is set up afresh only
 * between runs, so spending the other on the run in progress would send
 * the plan a request shaped for the key, or the reverse. Past the run, or
 * the bound, the owner's current choice applies.
 */
export class OpenAiAccessAllowances {
  readonly #options: OpenAiAccessAllowancesOptions;
  readonly #clock: () => Date;

  constructor(options: OpenAiAccessAllowancesOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date());
  }

  /**
   * Records, before the owner's access may change from `currentAccess`,
   * what the thread's open run spends: what an earlier change during the
   * same run recorded, or else `currentAccess`, which is what the run began
   * with. A thread with no run open needs nothing.
   */
  async noteBeforeChange(threadId: string, currentAccess: ProviderAccess): Promise<void> {
    const { store, threadEventLog } = this.#options;
    const runStartedAtSequence = await threadEventLog.readOpenRunStart(threadId);
    if (runStartedAtSequence === undefined) {
      await store.remove(threadId);
      return;
    }
    if ((await this.#findValid(threadId, runStartedAtSequence)) !== undefined) {
      return;
    }
    await store.save({
      threadId,
      runAccess: currentAccess,
      runStartedAtSequence,
      allowedUntil: new Date(this.#clock().getTime() + previousModelAllowedForInMilliseconds),
    });
  }

  /** What the run open now began with, if the owner's access changed during it. */
  async findRunAccess(threadId: string): Promise<ProviderAccess | undefined> {
    const runStartedAtSequence = await this.#options.threadEventLog.readOpenRunStart(threadId);
    return runStartedAtSequence === undefined
      ? undefined
      : (await this.#findValid(threadId, runStartedAtSequence))?.runAccess;
  }

  async #findValid(threadId: string, runStartedAtSequence: number) {
    const allowance = await this.#options.store.find(threadId);
    const isValid =
      allowance !== undefined &&
      allowance.runStartedAtSequence === runStartedAtSequence &&
      allowance.allowedUntil.getTime() > this.#clock().getTime();
    return isValid ? allowance : undefined;
  }
}
