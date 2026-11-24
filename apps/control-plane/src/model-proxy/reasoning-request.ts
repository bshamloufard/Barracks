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
 * - Chat Completions, as each relayed host takes it: `reasoning_effort`
 *   (OpenAI, Groq, xAI, Cerebras, DeepSeek, OpenRouter; `none` turns it
 *   off); OpenRouter's and Together's `reasoning` (`enabled: false` or
 *   `effort: "none"` off; `exclude` hides it but still generates it);
 *   DeepSeek's `thinking.type`; the older `include_reasoning`; and
 *   `chat_template_kwargs.enable_thinking` or `.thinking` for open models.
 *   https://api-docs.deepseek.com/guides/thinking_mode
 *   https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 *   https://docs.together.ai/docs/inference/chat/reasoning
 *   https://inference-docs.cerebras.ai/capabilities/reasoning
 * A request that says both is taken as `on`, which errs high.
 */
export type ReasoningRequest = "on" | "off" | "unstated";

/** The top-level fields read for it. */
export const reasoningFields = [
  "thinking",
  "reasoning",
  "reasoning_effort",
  "include_reasoning",
  "chat_template_kwargs",
] as const;

export type ReasoningFields = Partial<Record<(typeof reasoningFields)[number], unknown>>;

export function readReasoningRequest(fields: ReasoningFields): ReasoningRequest {
  const signals = [
    thinkingSignal(fields.thinking),
    effortSignal(fields.reasoning_effort),
    reasoningObjectSignal(fields.reasoning),
    fields.include_reasoning === true ? "on" : "unstated",
    templateSignal(fields.chat_template_kwargs),
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

function templateSignal(templateSettings: unknown): ReasoningRequest {
  if (!isObject(templateSettings)) {
    return "unstated";
  }
  const stated = [templateSettings.enable_thinking, templateSettings.thinking];
  if (stated.includes(true)) {
    return "on";
  }
  return stated.includes(false) ? "off" : "unstated";
}

/** The members of these fields' objects that say whether to reason. */
type ReasoningSettings = Partial<
  Record<"type" | "enabled" | "effort" | "enable_thinking" | "thinking", unknown>
>;

function isObject(value: unknown): value is ReasoningSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
