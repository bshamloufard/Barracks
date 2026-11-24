/**
 * Where the model proxy keeps, per thread, the one model it still relays
 * after the thread's model was switched while a run was open (see
 * `ModelSwitchAllowances`). In the database, so a switch made through one
 * control plane instance holds at the other during a redeploy's overlap.
 */
export interface ModelSwitchAllowanceStore {
  /** Keeps the allowance, replacing the thread's earlier one. */
  save(allowance: ModelSwitchAllowance): Promise<void>;

  find(threadId: string): Promise<ModelSwitchAllowance | undefined>;

  /** Removes the thread's allowance, if it has one. */
  remove(threadId: string): Promise<void>;
}

export type ModelSwitchAllowance = {
  threadId: string;
  /** The model before the switch, as `provider/model`. */
  previousModel: string;
  /** The run it is allowed for: the sequence of the `agent_run_started` that began it. */
  runStartedAtSequence: number;
  allowedUntil: Date;
};
