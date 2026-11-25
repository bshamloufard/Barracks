import { chatGptUsageSettingsUrl, type ModelAccessErrorKind } from "@barrack/protocol";

export type ModelAccessErrorDescription = {
  /** What happened, in plain words. */
  what: string;
  /** What the user can do next. */
  nextStep: string;
  /** Whether the next step is in Settings, so the page can link there. */
  isFixedInSettings: boolean;
  /**
   * Where the user manages their ChatGPT plan's usage, for a refusal of the
   * plan's, which OpenAI's guidelines make the first thing offered:
   * https://developers.openai.com/siwc/ui-ux-guidelines
   */
  manageUsageUrl?: string;
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
    case "usage_cap_reached":
      return {
        what: "You have reached your model usage cap, so Barrack stopped sending this thread's requests.",
        nextStep:
          "Wait for older usage to leave the cap's window, or raise your own cap in Settings, then send your message again.",
        isFixedInSettings: true,
      };
    case "plan_limit_reached":
      return {
        what: "Usage limit reached: your ChatGPT plan, or the limit you set for Barrack in ChatGPT, has no allowance left for now. OpenAI did not say when it resets.",
        nextStep:
          "Review your plan or this app's limit in ChatGPT settings, or switch this thread to another model or to your API key; send your message again to resume.",
        isFixedInSettings: false,
        manageUsageUrl: chatGptUsageSettingsUrl,
      };
    case "plan_not_eligible":
      return {
        what: "OpenAI says your ChatGPT account cannot be used here: its plan, or its workspace's policy, does not allow it.",
        nextStep:
          "If your ChatGPT account belongs to a workspace, ask its administrator to allow Barrack; otherwise switch this thread to your API key in Settings, then send your message again.",
        isFixedInSettings: true,
      };
    case "plan_sign_in_expired":
      return {
        what: "OpenAI no longer accepts Barrack's sign-in to your ChatGPT plan: it expired or was revoked, or what you allowed does not cover this request.",
        nextStep:
          "Connect your ChatGPT plan again in Settings (disconnect it first if it still shows as connected), then send your message again.",
        isFixedInSettings: true,
      };
    case "plan_capability_unsupported":
      return {
        what: "Your ChatGPT plan does not support something this request needs, such as its model.",
        nextStep:
          "Switch this thread to a model your plan offers (Settings lists them), then send your message again.",
        isFixedInSettings: true,
      };
  }
}
