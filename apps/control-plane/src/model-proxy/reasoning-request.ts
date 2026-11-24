/**
 * Whether a request asks the model to reason before it answers (`on`),
 * tells it not to (`off`), or says neither (`unstated`), from the fields
 * each relayed provider documents for it. Reasoning is generated before
 * the visible answer and, unless summarised, never shown, so an answer cut
 * short after it can have cost far more than was seen; see
 * `answer-usage.ts` for how that is counted.
 *
 * - Anthropic's Messages API: `thinking` (`enabled` or `adaptive`, or
 *   `disabled`). https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
 * - OpenAI's Responses API: `reasoning.effort`, `none` turning it off.
 *   https://platform.openai.com/docs/api-reference/responses/create
 * - Chat Completions, as the agent sends it to each relayed host:
 *   `reasoning_effort` (Groq, Cerebras, DeepSeek, Together; `none` turns
 *   it off); OpenRouter's and Together's `reasoning` (`enabled: false` or
 *   `effort: "none"` off); and DeepSeek's `thinking.type`.
 *   https://api-docs.deepseek.com/guides/thinking_mode
 *   https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 *   https://docs.together.ai/docs/inference/chat/reasoning
 *   https://inference-docs.cerebras.ai/capabilities/reasoning
 * Only these fields, with the values the agent gives them, reach here
 * (see `agent-request-shapes.json`). A request that says both is taken as
 * `on`, which errs high.
 */
export type ReasoningRequest = "on" | "off" | "unstated";

/** The top-level fields read for it. */
export const reasoningFields = ["thinking", "reasoning", "reasoning_effort"] as const;

export type ReasoningFields = Partial<Record<(typeof reasoningFields)[number], unknown>>;

export function readReasoningRequest(fields: ReasoningFields): ReasoningRequest {
  const signals = [
    thinkingSignal(fields.thinking),
    effortSignal(fields.reasoning_effort),
    reasoningObjectSignal(fields.reasoning),
  ];
  if (signals.includes("on")) {
    return "on";
  }
  return signals.includes("off") ? "off" : "unstated";
}

function thinkingSignal(thinking: unknown): ReasoningRequest {
  if (!isObject(thinking)) {
    return "unstated";
  }
  return thinking.type === "disabled" ? "off" : "on";
}

function effortSignal(effort: unknown): ReasoningRequest {
  if (typeof effort !== "string") {
    return "unstated";
  }
  return effort === "none" ? "off" : "on";
}

function reasoningObjectSignal(reasoning: unknown): ReasoningRequest {
  if (!isObject(reasoning)) {
    return "unstated";
  }
  return reasoning.enabled === false || reasoning.effort === "none" ? "off" : "on";
}

/** The members of these fields' objects that say whether to reason. */
type ReasoningSettings = Partial<Record<"type" | "enabled" | "effort", unknown>>;

function isObject(value: unknown): value is ReasoningSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
