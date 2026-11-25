import {
  type ChatGptPlanDisconnection,
  type ChatGptPlanModel,
  type ChatGptPlanSignInStart,
  type ChatGptPlanStatus,
  chatGptPlanApiPath,
  chatGptPlanDisconnectionSchema,
  chatGptPlanModelListSchema,
  chatGptPlanModelsApiPath,
  chatGptPlanOpenAiAccessApiPath,
  chatGptPlanSignInApiPath,
  chatGptPlanSignInCompletionApiPath,
  chatGptPlanSignInStartSchema,
  chatGptPlanStatusSchema,
  type ProviderAccess,
} from "@barrack/protocol";
import type { AuthorizedFetch } from "./authorized-fetch";
import { readApiAnswer } from "./read-api-answer";

/**
 * The control plane's ChatGPT plan API (see `@barrack/protocol`'s
 * `chatgpt-plan.ts`): connecting the user's plan by the address their
 * browser ends on, choosing whether OpenAI models run on it, its models,
 * and disconnecting. The page never holds any of the plan's tokens.
 */
export class ChatGptPlanApi {
  readonly #request: AuthorizedFetch;

  constructor(request: AuthorizedFetch) {
    this.#request = request;
  }

  async readStatus(): Promise<ChatGptPlanStatus> {
    const response = await this.#request(chatGptPlanApiPath);
    return readApiAnswer(response, chatGptPlanStatusSchema, "read your ChatGPT plan");
  }

  async startSignIn(): Promise<ChatGptPlanSignInStart> {
    const response = await this.#sendJson("POST", chatGptPlanSignInApiPath, {
      allowsBackgroundUse: true,
    });
    return readApiAnswer(response, chatGptPlanSignInStartSchema, "begin the sign-in");
  }

  /** Throws `ApiRefusal` with the control plane's explanation when the address cannot finish it. */
  async finishSignIn(finalAddress: string): Promise<ChatGptPlanStatus> {
    const response = await this.#sendJson("POST", chatGptPlanSignInCompletionApiPath, {
      finalAddress,
    });
    return readApiAnswer(response, chatGptPlanStatusSchema, "finish the sign-in");
  }

  async changeOpenAiAccess(access: ProviderAccess): Promise<ChatGptPlanStatus> {
    const response = await this.#sendJson("PUT", chatGptPlanOpenAiAccessApiPath, { access });
    return readApiAnswer(response, chatGptPlanStatusSchema, "save your choice");
  }

  async disconnect(): Promise<ChatGptPlanDisconnection> {
    const response = await this.#request(chatGptPlanApiPath, { method: "DELETE" });
    return readApiAnswer(response, chatGptPlanDisconnectionSchema, "disconnect your plan");
  }

  async listModels(): Promise<ChatGptPlanModel[]> {
    const response = await this.#request(chatGptPlanModelsApiPath);
    return (await readApiAnswer(response, chatGptPlanModelListSchema, "list your plan's models"))
      .models;
  }

  #sendJson(method: "POST" | "PUT", path: string, body: object): Promise<Response> {
    return this.#request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}
