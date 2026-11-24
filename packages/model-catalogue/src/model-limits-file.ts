/**
 * What the pinned agent knows of each model of a relayed provider that the
 * control plane needs and clients do not: the most output the model can
 * generate in one answer, and the other models of the same provider the
 * agent lets the provider answer with instead (Anthropic's server-side
 * fallbacks). Generated from the agent beside the catalogue (see
 * `scripts/`).
 */
export type ModelLimits = {
  maxOutputTokens: number;
  fallbackModelIds: string[];
};

/** By provider, then by model. */
export type ModelLimitsFile = Record<string, Record<string, ModelLimits>>;

/** Beside `src` and `dist` alike, so the sources and the build read the same file. */
export const modelLimitsFileUrl = new URL("../model-limits.json", import.meta.url);

/**
 * The file as it is written: two-space JSON, ending in a line break, with
 * each list of model names on one line, as the repository's formatter
 * would write it.
 */
export function formatModelLimits(limits: ModelLimitsFile): string {
  const expanded = JSON.stringify(limits, null, 2);
  const onOneLine = expanded.replace(
    /\[\n\s+("[^"\n]*"(?:,\n\s+"[^"\n]*")*)\n\s+\]/g,
    (_list, names: string) => `[${names.split(/,\n\s+/).join(", ")}]`,
  );
  return `${onOneLine}\n`;
}
