import type { ChatGptPlanStatus } from "@barrack/protocol";

/**
 * What Settings says of the user's ChatGPT plan, in words OpenAI's
 * guidelines for its "Sign in with ChatGPT" programme use where they give
 * them (https://developers.openai.com/siwc/ui-ux-guidelines): the card is
 * "Use your ChatGPT plan", the button "Continue with ChatGPT".
 */
export type ChatGptPlanDescription =
  | { kind: "turned_off"; explanation: string }
  | { kind: "not_connected"; lossNotice: string | undefined }
  | { kind: "connected"; account: string; since: string; isInUse: boolean };

export const planCardTitle = "Use your ChatGPT plan";
export const planCardText =
  "Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.";
export const continueWithChatGptLabel = "Continue with ChatGPT";

/** Said once, after the first connection, as the guidelines ask. */
export const planInUseNotice = {
  title: "You're using your ChatGPT plan",
  text: "Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.",
  dismissLabel: "Got it",
};

export function describeChatGptPlan(
  status: ChatGptPlanStatus,
  formatDate: (isoDate: string) => string,
): ChatGptPlanDescription {
  if (status.availability === "turned_off") {
    return {
      kind: "turned_off",
      explanation:
        "This installation does not offer ChatGPT plans. OpenAI's terms let an app keep a ChatGPT sign-in only on infrastructure the account holder controls, so Barrack offers it only where the person running an installation, for themselves alone, turns it on (BARRACK_CHATGPT_PLAN_SIGN_IN in the deployment guide). Your OpenAI models run on your API key.",
    };
  }
  if (status.connection === null) {
    return {
      kind: "not_connected",
      lossNotice:
        status.loss === null
          ? undefined
          : `Your ChatGPT sign-in expired or was revoked (${formatDate(status.loss.at)}), so Barrack forgot it. Threads on your plan wait until you connect it again, or switch OpenAI to your API key below.`,
    };
  }
  return {
    kind: "connected",
    account: status.connection.accountEmail ?? "your ChatGPT account",
    since: formatDate(status.connection.connectedAt),
    isInUse: status.openAiAccess === "chatgpt_plan",
  };
}

/** The steps, said before the user begins, so the page that fails to load surprises no one. */
export const signInSteps = [
  "Choose Continue with ChatGPT. OpenAI's page opens in a new tab; sign in there if asked, and approve Barrack.",
  "Your browser then goes to an address starting http://127.0.0.1:1455/auth/callback? and the page fails to load. That is expected: that address is how OpenAI hands the sign-in back.",
  "Copy the whole address from that tab's address bar, paste it below, and choose Finish connecting. Do it straight away: it works once, and only for a few minutes.",
];
