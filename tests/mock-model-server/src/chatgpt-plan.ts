import type { ServerResponse } from "node:http";

/**
 * How the mock answers OpenAI requests sent with a ChatGPT plan's access
 * token, as OpenAI's "Sign in with ChatGPT" programme documents its API
 * (read 2026-11-25):
 * https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
 * https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 * https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
 *
 * Only `POST /v1/responses`, with `store: false` and `stream: true`, and
 * none of the members, items or tools the programme refuses; and
 * `GET /v1/models`, listing the plan's models. Its refusals carry the
 * documented codes.
 */

/** What a plan's access token is to the mock: whose, and whether it is good. */
export type PlanTokenCheck =
  | { kind: "valid"; account: { subject: string; isEligible: boolean } }
  | { kind: "expired" | "revoked" }
  | { kind: "unknown" };

/** Tells a plan's access token from an API key, by asking the stand-in for OpenAI's sign-in. */
export type PlanTokenChecker = (accessToken: string) => PlanTokenCheck;

/** Members the programme's preview refuses, as its limitations page lists them. */
const unsupportedMembers = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

/** Hosted tools the programme refuses. */
const unsupportedToolTypes = [
  "file_search",
  "code_interpreter",
  "computer_use_preview",
  "mcp",
  "image_generation",
  "tool_search",
];

/** The plan's models, in the order OpenAI would list them; one hidden, one the agent does not know. */
export const planModels = [
  { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
  { slug: "gpt-6.2-sol", display_name: "GPT-6.2 Sol", visibility: "list" },
  { slug: "gpt-6.2-internal", display_name: "Internal", visibility: "hide" },
  { slug: "a-model-the-agent-does-not-know", display_name: "Unknown", visibility: "list" },
];

export type PlanRefusal = { status: number; code: string; message: string; param?: string };

/** Why a plan request is refused before it is answered, or undefined when it is served. */
export function findPlanRefusal(
  check: PlanTokenCheck,
  body: Record<string, unknown>,
): PlanRefusal | undefined {
  if (check.kind !== "valid") {
    return {
      status: 401,
      code: "subscription_sharing_invalid_user",
      message: "The ChatGPT sign-in is not valid.",
    };
  }
  if (!check.account.isEligible) {
    return {
      status: 403,
      code: "subscription_sharing_user_not_eligible",
      message: "This ChatGPT account is not eligible to use its plan here.",
    };
  }
  const param = findUnsupportedParam(body);
  return param === undefined
    ? undefined
    : {
        status: 400,
        code: "subscription_sharing_unsupported_capability",
        message: "This request uses something ChatGPT plan usage does not support.",
        param,
      };
}

/** The usage limit's refusal, for a plan the test declared spent. */
export const planLimitRefusal: PlanRefusal = {
  status: 429,
  code: "subscription_sharing_usage_limit_exceeded",
  message: "You have reached your ChatGPT plan's usage limit.",
};

export function writePlanRefusal(response: ServerResponse, refusal: PlanRefusal): void {
  response.writeHead(refusal.status, { "content-type": "application/json" }).end(
    JSON.stringify({
      error: {
        message: refusal.message,
        type: "invalid_request_error",
        param: refusal.param ?? null,
        code: refusal.code,
      },
    }),
  );
}

export function writePlanModels(response: ServerResponse): void {
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ models: planModels }));
}

function findUnsupportedParam(body: Record<string, unknown>): string | undefined {
  if (body["store"] !== false) {
    return "store";
  }
  if (body["stream"] !== true) {
    return "stream";
  }
  const member = unsupportedMembers.find((name) => Object.hasOwn(body, name));
  if (member !== undefined) {
    return member;
  }
  const items = Array.isArray(body["input"])
    ? (body["input"] as Array<Record<string, unknown>>)
    : [];
  if (items.some((item) => item["type"] === "configuration_update")) {
    return "input.configuration_update";
  }
  if (items.some((item) => item["role"] === "system")) {
    return "input.role";
  }
  const tools = Array.isArray(body["tools"])
    ? (body["tools"] as Array<Record<string, unknown>>)
    : [];
  const tool = tools.find((candidate) => unsupportedToolTypes.includes(String(candidate["type"])));
  return tool === undefined ? undefined : "tools";
}
