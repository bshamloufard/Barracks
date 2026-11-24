import { readFileSync } from "node:fs";
import { type ModelLimits, modelLimitsFileUrl } from "./model-limits-file.js";

const limitsByProvider = parseModelLimits(JSON.parse(readFileSync(modelLimitsFileUrl, "utf8")));

/**
 * The model's limits (see `model-limits-file.ts`), if the pinned agent
 * lists the model for a relayed provider. Read and checked once, when
 * first imported.
 */
export function findModelLimits(providerId: string, modelId: string): ModelLimits | undefined {
  return limitsByProvider.get(providerId)?.get(modelId);
}

/** The most output any model the pinned agent lists for the provider can generate. */
export function findLargestMaxOutputTokens(providerId: string): number | undefined {
  const models = [...(limitsByProvider.get(providerId)?.values() ?? [])];
  return models.length === 0
    ? undefined
    : Math.max(...models.map((model) => model.maxOutputTokens));
}

function parseModelLimits(file: unknown): Map<string, Map<string, ModelLimits>> {
  const providers = new Map<string, Map<string, ModelLimits>>();
  for (const [providerId, models] of Object.entries(asRecord(file, "the file"))) {
    const byModel = new Map<string, ModelLimits>();
    for (const [modelId, limits] of Object.entries(asRecord(models, providerId))) {
      byModel.set(modelId, parseLimits(limits, `${providerId}/${modelId}`));
    }
    providers.set(providerId, byModel);
  }
  return providers;
}

function parseLimits(value: unknown, where: string): ModelLimits {
  const { maxOutputTokens, fallbackModelIds } = asRecord(value, where);
  if (
    typeof maxOutputTokens !== "number" ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens <= 0 ||
    !Array.isArray(fallbackModelIds) ||
    !fallbackModelIds.every((modelId) => typeof modelId === "string")
  ) {
    throw new Error(`model-limits.json is not as generated, at ${where}`);
  }
  return { maxOutputTokens, fallbackModelIds };
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`model-limits.json is not as generated, at ${where}`);
  }
  return value as Record<string, unknown>;
}
