import {
  type AcceptedModelProxyToken,
  keptPerProvider,
  type ModelProxyTokenStore,
} from "./model-proxy-token-store.js";

/** Model proxy tokens in memory, for development and tests. Lost on restart. */
export class InMemoryModelProxyTokenStore implements ModelProxyTokenStore {
  readonly #tokens: AcceptedModelProxyToken[] = [];

  async accept(token: AcceptedModelProxyToken): Promise<void> {
    this.#tokens.push(token);
    const sameProvider = this.#tokens
      .filter((kept) => kept.threadId === token.threadId && kept.providerId === token.providerId)
      .sort((first, second) => second.mintedAt.getTime() - first.mintedAt.getTime());
    for (const retired of sameProvider.slice(keptPerProvider)) {
      this.#tokens.splice(this.#tokens.indexOf(retired), 1);
    }
  }

  async listDigests(threadId: string, providerId: string): Promise<Buffer[]> {
    return this.#tokens
      .filter((token) => token.threadId === threadId && token.providerId === providerId)
      .map((token) => token.digest);
  }

  async revokeThread(threadId: string): Promise<void> {
    this.#removeWhere((token) => token.threadId === threadId);
  }

  async retainProviders(threadId: string, keptProviderIds: readonly string[]): Promise<void> {
    this.#removeWhere(
      (token) => token.threadId === threadId && !keptProviderIds.includes(token.providerId),
    );
  }

  #removeWhere(isRemoved: (token: AcceptedModelProxyToken) => boolean): void {
    for (let index = this.#tokens.length - 1; index >= 0; index -= 1) {
      const token = this.#tokens[index];
      if (token !== undefined && isRemoved(token)) {
        this.#tokens.splice(index, 1);
      }
    }
  }
}
