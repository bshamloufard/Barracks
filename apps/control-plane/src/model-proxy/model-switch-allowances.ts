import { parseModelReference } from "@barrack/protocol";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type { ModelProxyTokens } from "./model-proxy-tokens.js";
import type { ModelSwitchAllowanceStore } from "./model-switch-allowance-store.js";

/**
 * How long the model before a switch stays usable for the run that began
 * on it. A switch takes effect for the agent's next run, so the run in
 * progress carries on with its model; but whether a run is open is known
 * only from the agent's own events, which the agent could keep from ever
 * ending one. Half an hour lets an ordinary run (seconds to minutes of
 * model requests, each limited to an hour by the proxy) finish, and puts a
 * bound on what a run held open on purpose can spend on a model the user
 * has moved away from; past it the run's requests are refused and the user
 * sends their next message on the new model.
 */
export const previousModelAllowedForInMilliseconds = 30 * 60_000;

export type ModelSwitchAllowancesOptions = {
  store: ModelSwitchAllowanceStore;
  threadEventLog: ThreadEventLog;
  tokens: ModelProxyTokens;
  clock?: () => Date;
};

/**
 * Which models the model proxy relays for a thread besides its own: at
 * most the one it ran on before a switch made while a run was open, for
 * that run alone (as the control plane recorded it when the switch was
 * made, by the sequence of the event that began it) and for at most
 * `previousModelAllowedForInMilliseconds`. Any model before that one is
 * never relayed again, and its provider's tokens are retired.
 */
export class ModelSwitchAllowances {
  readonly #options: ModelSwitchAllowancesOptions;
  readonly #clock: () => Date;

  constructor(options: ModelSwitchAllowancesOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date());
  }

  /**
   * Records a switch from `previousModel` to `newModel`, before the thread's
   * record changes, so no request of the run in progress is refused in
   * between. A run still open on the model it began with (allowed by an
   * earlier switch during the same run) keeps that model, since that is
   * what it runs on. Then retires the tokens of every provider no longer
   * needed.
   */
  async noteSwitch(
    threadId: string,
    previousModel: string | undefined,
    newModel: string,
  ): Promise<void> {
    const { store, threadEventLog, tokens } = this.#options;
    const runStartedAtSequence = await threadEventLog.readOpenRunStart(threadId);
    const earlier = await this.#findValid(threadId, runStartedAtSequence);
    const runModel = earlier?.previousModel ?? previousModel;
    if (runStartedAtSequence === undefined || runModel === undefined || runModel === newModel) {
      await store.remove(threadId);
      await tokens.retainProviders(threadId, [parseModelReference(newModel).providerId]);
      return;
    }
    await store.save({
      threadId,
      previousModel: runModel,
      runStartedAtSequence,
      allowedUntil: earlier?.allowedUntil ?? this.#allowedUntilFromNow(),
    });
    await tokens.retainProviders(threadId, [
      parseModelReference(newModel).providerId,
      parseModelReference(runModel).providerId,
    ]);
  }

  /** The model the run open now may still use besides the thread's own, if any. */
  async findPreviousModel(threadId: string): Promise<string | undefined> {
    const runStartedAtSequence = await this.#options.threadEventLog.readOpenRunStart(threadId);
    return (await this.#findValid(threadId, runStartedAtSequence))?.previousModel;
  }

  async #findValid(threadId: string, runStartedAtSequence: number | undefined) {
    if (runStartedAtSequence === undefined) {
      return undefined;
    }
    const allowance = await this.#options.store.find(threadId);
    const isValid =
      allowance !== undefined &&
      allowance.runStartedAtSequence === runStartedAtSequence &&
      allowance.allowedUntil.getTime() > this.#clock().getTime();
    return isValid ? allowance : undefined;
  }

  #allowedUntilFromNow(): Date {
    return new Date(this.#clock().getTime() + previousModelAllowedForInMilliseconds);
  }
}
