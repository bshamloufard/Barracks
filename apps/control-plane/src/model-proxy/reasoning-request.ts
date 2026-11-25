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
 *   Its `output_config.effort` is taken as asking too: the agent sends it
 *   only with thinking on, and in a system message mid-conversation it sets
 *   the effort of the replies after it.
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
 *
 * These are read at the top level and in each conversation item that
 * carries settings (Anthropic's system message, the Responses API's
 * `configuration_update`), which can restate them for the rest of the
 * conversation. Only these fields, with the values the agent gives them in
 * each place, reach here (see `agent-request-shapes.json`). A request is
 * `on` if any of them asks, wherever it is, even if another says not to,
 * which errs high.
 */
export type ReasoningRequest = "on" | "off" | "unstated";

/** The fields read for it. */
export const reasoningFields = [
  "thinking",
  "reasoning",
  "reasoning_effort",
  "output_config",
] as const;

export type ReasoningFields = Partial<Record<(typeof reasoningFields)[number], unknown>>;

/** From the top-level fields and those of each conversation item that carries settings. */
export function readReasoningRequest(
  fields: ReasoningFields,
  itemSettings: readonly ReasoningFields[] = [],
): ReasoningRequest {
  const signals = [fields, ...itemSettings].flatMap((stated) => [
    thinkingSignal(stated.thinking),
    effortSignal(stated.reasoning_effort),
    reasoningObjectSignal(stated.reasoning),
    outputConfigSignal(stated.output_config),
  ]);
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

function outputConfigSignal(outputConfig: unknown): ReasoningRequest {
  return isObject(outputConfig) && outputConfig.effort !== undefined ? "on" : "unstated";
}

/** The members of these fields' objects that say whether to reason. */
type ReasoningSettings = Partial<Record<"type" | "enabled" | "effort", unknown>>;

function isObject(value: unknown): value is ReasoningSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
