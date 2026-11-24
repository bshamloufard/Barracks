import type {
  ModelSwitchAllowance,
  ModelSwitchAllowanceStore,
} from "./model-switch-allowance-store.js";

/** Model switch allowances in memory, for development and tests. Lost on restart. */
export class InMemoryModelSwitchAllowanceStore implements ModelSwitchAllowanceStore {
  readonly #allowances = new Map<string, ModelSwitchAllowance>();

  async save(allowance: ModelSwitchAllowance): Promise<void> {
    this.#allowances.set(allowance.threadId, { ...allowance });
  }

  async find(threadId: string): Promise<ModelSwitchAllowance | undefined> {
    const allowance = this.#allowances.get(threadId);
    return allowance === undefined ? undefined : { ...allowance };
  }

  async remove(threadId: string): Promise<void> {
    this.#allowances.delete(threadId);
  }
}
