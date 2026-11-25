import { findCatalogueProvider } from "@barrack/model-catalogue";
import type { ChatGptPlanModel } from "@barrack/protocol";
import { z } from "zod";
import { type ChatGptPlanAccess, chatGptPlanProviderId } from "./chatgpt-plan-access.js";
import { readBoundedJson } from "./read-bounded-json.js";

/**
 * The models a user's ChatGPT plan offers, as OpenAI's programme documents
 * finding them: `GET /v1/models` with the plan's access token, keeping
 * those whose `visibility` is `list`, in the order given, by their
 * `display_name` and `slug`
 * (https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
 * Only those the pinned agent lists for OpenAI are offered, since a
 * thread's agent runs only models it knows and the model proxy relays only
 * requests shaped as it sends them; the plan may offer others.
 */

const modelListSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1).max(256),
      display_name: z.string().min(1).max(256).optional(),
      visibility: z.string().optional(),
    }),
  ),
});

const requestTimeoutInMilliseconds = 15_000;

/** A bound on the model list, many times what a plan's list of models takes. */
const maximumModelListBytes = 1024 * 1024;

export type PlanModelListing =
  | { kind: "listed"; models: ChatGptPlanModel[] }
  | { kind: "not_connected" }
  | { kind: "unavailable" };

export class ChatGptPlanModels {
  readonly #access: ChatGptPlanAccess;
  readonly #apiBaseUrl: string;

  /** `apiBaseUrl` is `https://api.openai.com/v1`, or a stand-in for it in tests. */
  constructor(access: ChatGptPlanAccess, apiBaseUrl: string) {
    this.#access = access;
    this.#apiBaseUrl = apiBaseUrl;
  }

  async list(ownerUserId: string): Promise<PlanModelListing> {
    const token = await this.#access.findAccessToken(ownerUserId);
    if (token.kind === "not_connected") {
      return token;
    }
    let response: Response;
    try {
      response = await fetch(`${this.#apiBaseUrl}/models`, {
        headers: { authorization: `Bearer ${token.accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutInMilliseconds),
      });
    } catch {
      return { kind: "unavailable" };
    }
    if (response.status === 401) {
      await response.body?.cancel();
      await this.#access.renewAfterRefusal(ownerUserId, token.accessToken);
      return { kind: "unavailable" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: "unavailable" };
    }
    let answer: unknown;
    try {
      answer = await readBoundedJson(response, maximumModelListBytes);
    } catch {
      return { kind: "unavailable" };
    }
    const listed = modelListSchema.safeParse(answer);
    if (!listed.success) {
      return { kind: "unavailable" };
    }
    const agentModelIds = new Set(
      findCatalogueProvider(chatGptPlanProviderId)?.models.map((model) => model.modelId),
    );
    const models = listed.data.models
      .filter((model) => model.visibility === "list" && agentModelIds.has(model.slug))
      .map((model) => ({ modelId: model.slug, name: model.display_name ?? model.slug }));
    return { kind: "listed", models };
  }
}
