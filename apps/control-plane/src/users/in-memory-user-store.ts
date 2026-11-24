import type { UserStore } from "./user-store.js";

/** Keeps users in process memory, for local development and tests. */
export class InMemoryUserStore implements UserStore {
  readonly #confirmedEmailDigests = new Map<string, Buffer | undefined>();

  async recordUser(userId: string, confirmedEmailDigest: Buffer | undefined): Promise<void> {
    this.#confirmedEmailDigests.set(userId, confirmedEmailDigest);
  }

  async hasUser(userId: string): Promise<boolean> {
    return this.#confirmedEmailDigests.has(userId);
  }

  async readConfirmedEmailDigest(userId: string): Promise<Buffer | undefined> {
    return this.#confirmedEmailDigests.get(userId);
  }
}
