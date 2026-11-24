import { parseModelReference } from "@barrack/protocol";
import type { ModelAccess } from "./agent-harness.js";

/** Whether the agent has a model and a credential for it, and so can answer. */
export function isModelAccessUsable(access: ModelAccess | undefined): access is UsableModelAccess {
  return access?.model != null && access.credential !== null;
}

export type UsableModelAccess = {
  model: string;
  credential: NonNullable<ModelAccess["credential"]>;
};

/**
 * What a harness tells the user, in an errored assistant message, when a
 * message reaches an agent that has no model or no key for it: the control
 * plane refuses such messages, but one recorded earlier (before the key was
 * removed, say) can still arrive.
 */
export function describeMissingModelAccess(access: ModelAccess | undefined): string {
  if (access?.model == null) {
    return "This thread has no model, so the agent cannot answer. Choose a model for the thread, then send your message again.";
  }
  const { providerId } = parseModelReference(access.model);
  return `There is no API key for the provider "${providerId}", which this thread's model, ${access.model}, needs, so the agent cannot answer. Add one in Settings, then send your message again.`;
}
