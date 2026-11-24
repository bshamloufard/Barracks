import type { UserStore } from "./user-store.js";

/** Keeps users in process memory, for local development and tests. */
export class InMemoryUserStore implements UserStore {
  readonly #userIds = new Set<string>();

  async recordUser(userId: string): Promise<void> {
    this.#userIds.add(userId);
  }

  async hasUser(userId: string): Promise<boolean> {
    return this.#userIds.has(userId);
  }
}
