import { type ConfigureModelAccess, parseModelReference } from "@barrack/protocol";
import type { ThreadModelAccess } from "../thread-relay/thread-model-access.js";
import type { ThreadStore } from "../threads/thread-store.js";
import type { ModelCredentials } from "./model-credentials.js";

/**
 * Each thread's model access, decided from the thread's own record: its
 * model, and its owner's credential for that model's provider. A sandbox
 * therefore only ever receives its own thread's owner's key, and only for
 * its own thread's model, whatever its supervisor sends.
 *
 * When the credential is sealed under a key this control plane does not
 * hold, `describe` throws rather than describe no credential: the relay
 * then leaves an attached supervisor with the key it has, and turns away
 * one attaching, which reconnects, normally to the instance that holds
 * the key.
 */
export class OwnerModelAccess implements ThreadModelAccess {
  readonly #threadStore: ThreadStore;
  readonly #credentials: ModelCredentials;
  readonly #isModelRequired: boolean;

  /** `isModelRequired`: the agent cannot run without one (Pi); the fake agent can. */
  constructor(options: {
    threadStore: ThreadStore;
    credentials: ModelCredentials;
    isModelRequired: boolean;
  }) {
    this.#threadStore = options.threadStore;
    this.#credentials = options.credentials;
    this.#isModelRequired = options.isModelRequired;
  }

  async describe(threadId: string): Promise<ConfigureModelAccess> {
    const thread = await this.#threadStore.find(threadId);
    const model = thread?.model;
    const ownerUserId = thread?.ownerUserId;
    if (model === undefined || ownerUserId === undefined) {
      return { type: "configure_model_access", model: model ?? null, credential: null };
    }
    const credential = await this.#credentials.read(
      ownerUserId,
      parseModelReference(model).providerId,
    );
    return {
      type: "configure_model_access",
      model,
      credential: credential === undefined ? null : { kind: "api_key", ...credential },
    };
  }

  async admitUserMessage(
    threadId: string,
  ): Promise<{ isAccepted: true } | { isAccepted: false; reason: string }> {
    const thread = await this.#threadStore.find(threadId);
    if (thread === undefined || thread.ownerUserId === undefined) {
      return { isAccepted: true };
    }
    if (thread.model === undefined) {
      return this.#isModelRequired
        ? {
            isAccepted: false,
            reason:
              "This thread has no model yet. Choose one for it, then send your message again.",
          }
        : { isAccepted: true };
    }
    const missing = await this.#credentials.describeMissingCredential(
      thread.ownerUserId,
      thread.model,
      "send your message again",
    );
    return missing === undefined ? { isAccepted: true } : { isAccepted: false, reason: missing };
  }
}
