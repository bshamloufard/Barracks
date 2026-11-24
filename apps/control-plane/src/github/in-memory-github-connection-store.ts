import type {
  GithubConnectionAttempt,
  GithubConnectionRecord,
  GithubConnectionStore,
} from "./github-connection-store.js";

/** Keeps GitHub links in memory, for development and tests. */
export class InMemoryGithubConnectionStore implements GithubConnectionStore {
  readonly #attempts = new Map<string, GithubConnectionAttempt>();
  readonly #connections = new Map<string, GithubConnectionRecord>();

  async saveAttempt(attempt: GithubConnectionAttempt): Promise<void> {
    for (const [key, existing] of this.#attempts) {
      if (existing.userId === attempt.userId) {
        this.#attempts.delete(key);
      }
    }
    this.#attempts.set(attempt.stateDigest.toString("hex"), structuredClone(attempt));
  }

  async takeAttempt(stateDigest: Buffer): Promise<GithubConnectionAttempt | undefined> {
    const key = stateDigest.toString("hex");
    const attempt = this.#attempts.get(key);
    this.#attempts.delete(key);
    return attempt;
  }

  async save(connection: GithubConnectionRecord): Promise<void> {
    this.#connections.set(connection.userId, structuredClone(connection));
  }

  async find(userId: string): Promise<GithubConnectionRecord | undefined> {
    const connection = this.#connections.get(userId);
    return connection === undefined ? undefined : structuredClone(connection);
  }

  async remove(userId: string): Promise<void> {
    this.#connections.delete(userId);
  }
}
