import type { ModelAccessErrorKind } from "@barrack/protocol";

export type ModelAccessErrorDescription = {
  /** What happened, in plain words. */
  what: string;
  /** What the user can do next. */
  nextStep: string;
  /** Whether the next step is in Settings, so the page can link there. */
  isFixedInSettings: boolean;
};

/**
 * What a model provider's refusal means for the user, by the kind the agent's
 * harness recognised; the provider's own words are shown beneath it.
 */
export function describeModelAccessError(kind: ModelAccessErrorKind): ModelAccessErrorDescription {
  switch (kind) {
    case "credential_missing":
      return {
        what: "There is no API key for this thread's model provider, so the agent could not answer.",
        nextStep: "Add one in Settings, then send your message again.",
        isFixedInSettings: true,
      };
    case "credential_rejected":
      return {
        what: "The model provider rejected your API key.",
        nextStep: "Replace the key in Settings, then send your message again.",
        isFixedInSettings: true,
      };
    case "quota_exhausted":
      return {
        what: "Your account with the model provider has run out of credit or quota.",
        nextStep:
          "Add credit with the provider, or switch this thread to another model, then send your message again.",
        isFixedInSettings: false,
      };
    case "rate_limited":
      return {
        what: "The model provider is limiting how often you can call it, and the agent's retries ran out.",
        nextStep: "Wait a minute, then send your message again.",
        isFixedInSettings: false,
      };
  }
}
