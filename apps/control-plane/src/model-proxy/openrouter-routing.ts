/**
 * OpenRouter routes a request among the hosts of its model, and can also
 * route it to other models, which are then what is billed. A thread may
 * use only its own model, so the request fields that can choose another
 * model are refused, and those that only choose among hosts of the same
 * model are relayed (https://openrouter.ai/docs/guides/routing/model-fallbacks,
 * https://openrouter.ai/docs/guides/routing/provider-selection,
 * https://openrouter.ai/docs/guides/features/presets,
 * https://openrouter.ai/docs/guides/routing/routers/auto-router):
 *
 * - `models`, a list of models to fall back to: refused.
 * - `route`, which only tells how to use `models`: refused.
 * - `preset` (and a model named `…@preset/…`, which the model check
 *   refuses unless it is the thread's own), a saved configuration that can
 *   name models: refused.
 * - `provider`, the hosts to prefer, allow, ignore or sort by: relayed,
 *   but for its `options`, settings forwarded to a host as they stand,
 *   which could change anything: refused.
 * - `plugins`, every one: some choose the model (`auto-router`), and the
 *   rest are charges per call that the cap does not count (web search per
 *   request, file parsing per page;
 *   https://openrouter.ai/docs/guides/features/plugins). The pinned agent
 *   never sends any.
 * - A model suffix such as `:nitro`, `:floor` or `:free`: the model check
 *   refuses any model other than the thread's own, suffix and all.
 * - Anthropic-format `fallbacks`: may name only the thread's own model
 *   (see `ModelProxyAuthorization`).
 */
export const openRouterRoutingFields = [
  "models",
  "route",
  "preset",
  "provider",
  "plugins",
] as const;

export type OpenRouterRoutingFields = Partial<
  Record<(typeof openRouterRoutingFields)[number], unknown>
>;

/** Why the request could be answered by another model than it names, or run plugins, if it could. */
export function findModelChangingRouting(fields: OpenRouterRoutingFields): string | undefined {
  if (isSet(fields.models)) {
    return "it names other models to fall back to (`models`)";
  }
  if (isSet(fields.route)) {
    return "it asks for routing between models (`route`)";
  }
  if (isSet(fields.preset)) {
    return "it applies a preset, which can choose the model (`preset`)";
  }
  if (isObject(fields.provider) && isSet(fields.provider.options)) {
    return "it sets options forwarded to a host as they stand (`provider.options`)";
  }
  if (isSet(fields.plugins)) {
    return "it asks for plugins (`plugins`)";
  }
  return undefined;
}

/** Present with any value but `null`, which a provider takes as unset. */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function isObject(value: unknown): value is Partial<Record<"options", unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
