import type { ConfigureModelAccess } from "@barrack/protocol";

/**
 * What a thread relay needs to know about a thread's model access: what to
 * tell its supervisor (the model, and the owner's key for its provider),
 * and whether a user message can be taken at all. The relay only passes
 * these along; it holds none of the rules about keys.
 *
 * The relay decides nothing about which credential: it asks by thread, and
 * whoever answers decides from the thread's owner and model alone, so
 * nothing a supervisor sends can make it hand over any other.
 */
export interface ThreadModelAccess {
  /** What the thread's supervisor is told, after `prepare_workspace` and whenever it changes. */
  describe(threadId: string): Promise<ConfigureModelAccess>;

  /** Whether a user message may be recorded; why not otherwise, for the user. */
  admitUserMessage(
    threadId: string,
  ): Promise<{ isAccepted: true } | { isAccepted: false; reason: string }>;
}

/** For relays built without model access: no model, no key, and every message taken. */
export const noThreadModelAccess: ThreadModelAccess = {
  describe: async () => ({ type: "configure_model_access", model: null, credential: null }),
  admitUserMessage: async () => ({ isAccepted: true }),
};
