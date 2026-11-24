import type { ConfigureModelAccess, ReportedModelUsage } from "@barrack/protocol";

/**
 * What a thread relay needs to know about a thread's model access: what to
 * tell its supervisor (the model, and what reaches its provider on the
 * owner's account), whether a user message can be taken at all, and where
 * the agent's own account of its usage goes. The relay only passes these
 * along; it holds none of the rules about keys.
 *
 * The relay decides nothing about which credential: it asks by thread, and
 * whoever answers decides from the thread's owner and model alone, so
 * nothing a supervisor sends can make it hand over any other.
 */
export interface ThreadModelAccess {
  /**
   * What the thread's supervisor is told, after `prepare_workspace` and
   * whenever it changes. `connection` is that supervisor connection's own:
   * a token minted for the model proxy is kept there and handed out again
   * to the same connection, so it is told the same thing until something
   * really changes.
   */
  describe(threadId: string, connection: ModelAccessConnection): Promise<ConfigureModelAccess>;

  /** Whether a user message may be recorded; why not otherwise, for the user. */
  admitUserMessage(
    threadId: string,
  ): Promise<{ isAccepted: true } | { isAccepted: false; reason: string }>;

  /** The agent says an answer used this; it is counted as reported, where nothing measured it. */
  noteReportedUsage(threadId: string, usage: ReportedModelUsage): Promise<void>;
}

/** What one supervisor connection was given for the model proxy, by provider. */
export type ModelAccessConnection = { proxyTokens: Map<string, string> };

export function newModelAccessConnection(): ModelAccessConnection {
  return { proxyTokens: new Map() };
}

/** For relays built without model access: no model, no key, and every message taken. */
export const noThreadModelAccess: ThreadModelAccess = {
  describe: async () => ({ type: "configure_model_access", model: null, credential: null }),
  admitUserMessage: async () => ({ isAccepted: true }),
  noteReportedUsage: async () => undefined,
};
