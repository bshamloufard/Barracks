import { pino } from "pino";
import { ChatGptPlanAccess } from "../chatgpt-plan/chatgpt-plan-access.js";
import { openAiSignInIssuer } from "../chatgpt-plan/chatgpt-plan-settings.js";
import { ChatGptSignInClient } from "../chatgpt-plan/chatgpt-sign-in-client.js";
import { InMemoryChatGptPlanStore } from "../chatgpt-plan/in-memory-chatgpt-plan-store.js";
import type { CredentialKeyring } from "../model-access/credential-keyring.js";

/** ChatGPT plans as an installation that does not offer them has them: every user's OpenAI models run on keys. */
export function createUnofferedChatGptPlan(keyring: CredentialKeyring): ChatGptPlanAccess {
  return new ChatGptPlanAccess({
    settings: { isOffered: false, issuer: openAiSignInIssuer },
    store: new InMemoryChatGptPlanStore(keyring),
    client: new ChatGptSignInClient(openAiSignInIssuer),
    logger: pino({ level: "silent" }),
  });
}
