import type { ProviderAccess } from "@barrack/protocol";

/**
 * Where the model proxy keeps, per thread, what the run open when the
 * owner's OpenAI access changed began with (see `OpenAiAccessAllowances`).
 * In the database, so a change made through one control plane instance
 * holds at the other during a redeploy's overlap.
 */
export interface OpenAiAccessAllowanceStore {
  /** Keeps the allowance, replacing the thread's earlier one. */
  save(allowance: OpenAiAccessAllowance): Promise<void>;

  find(threadId: string): Promise<OpenAiAccessAllowance | undefined>;

  /** Removes the thread's allowance, if it has one. */
  remove(threadId: string): Promise<void>;
}

export type OpenAiAccessAllowance = {
  threadId: string;
  /** What the run's OpenAI requests spend: the owner's key or their plan. */
  runAccess: ProviderAccess;
  /** The run it is allowed for: the sequence of the `agent_run_started` that began it. */
  runStartedAtSequence: number;
  allowedUntil: Date;
};
