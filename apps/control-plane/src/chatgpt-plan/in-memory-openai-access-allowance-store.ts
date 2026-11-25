import type {
  OpenAiAccessAllowance,
  OpenAiAccessAllowanceStore,
} from "./openai-access-allowance-store.js";

/** OpenAI access allowances in memory, for development and tests. Lost on restart. */
export class InMemoryOpenAiAccessAllowanceStore implements OpenAiAccessAllowanceStore {
  readonly #allowances = new Map<string, OpenAiAccessAllowance>();

  async save(allowance: OpenAiAccessAllowance): Promise<void> {
    this.#allowances.set(allowance.threadId, { ...allowance });
  }

  async find(threadId: string): Promise<OpenAiAccessAllowance | undefined> {
    const allowance = this.#allowances.get(threadId);
    return allowance === undefined ? undefined : { ...allowance };
  }

  async remove(threadId: string): Promise<void> {
    this.#allowances.delete(threadId);
  }
}
