/**
 * The digests of the tokens each thread's agent may present to the model
 * proxy, by provider. Only digests are kept, so the store lets nobody use
 * the proxy; and they are in the database, so a token one control plane
 * instance minted works at another during a redeploy's overlap.
 */
export interface ModelProxyTokenStore {
  /**
   * Accepts a token for the thread and provider from now on, keeping only
   * the newest `keptPerProvider` for each: one is minted per supervisor
   * connection, so older ones belong to connections long gone.
   */
  accept(token: AcceptedModelProxyToken): Promise<void>;

  /** The digests accepted for the thread and provider. */
  listDigests(threadId: string, providerId: string): Promise<Buffer[]>;

  /** Accepts no token of the thread's any more, for any provider. */
  revokeThread(threadId: string): Promise<void>;

  /** Accepts the thread's tokens for these providers only, retiring the rest. */
  retainProviders(threadId: string, keptProviderIds: readonly string[]): Promise<void>;
}

export type AcceptedModelProxyToken = {
  threadId: string;
  providerId: string;
  digest: Buffer;
  mintedAt: Date;
};

/** A supervisor reconnecting a few times keeps working; a fifth connection retires the first's. */
export const keptPerProvider = 4;
