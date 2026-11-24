import { z } from "zod";
import { modelProviderIdSchema, modelReferenceSchema } from "./model-access.js";

/**
 * How many tokens a user's threads have used, and the cap on them. Barrack
 * counts tokens; it never prices them, since each user pays their own
 * provider at the provider's prices.
 *
 * Where the numbers come from (`source`):
 * - `measured`: read by the control plane's model proxy from the provider's
 *   own answer, for providers whose keys stay on the server. Trustworthy.
 * - `estimated`: also counted at the proxy, for an answer that ended before
 *   the provider said what it used (the agent hung up, or the connection
 *   broke): about one token per four characters seen. The provider bills
 *   what it produced, which these approach.
 * - `reported`: what the agent in the sandbox says it used, for providers
 *   whose keys are placed in the sandbox. The sandbox is untrusted, so these
 *   are shown for information only.
 *
 * The cap counts measured and estimated tokens alone (input, output and
 * cache, all together), over a window ending now. It is enforced only where
 * Barrack sees the traffic: for providers whose keys are placed in the
 * sandbox, it cannot be.
 */

export const modelUsageSourceSchema = z.enum(["measured", "estimated", "reported"]);

export type ModelUsageSource = z.infer<typeof modelUsageSourceSchema>;

/** More than any one answer uses, and small enough to add up safely. */
export const maximumTokensPerAnswer = 100_000_000;

const tokenCountSchema = z.int().nonnegative().max(maximumTokensPerAnswer);

/**
 * What one answer of the model used, as the agent reports it beside the
 * assistant message (see `assistantMessageEventSchema`).
 */
export const reportedModelUsageSchema = z.strictObject({
  model: modelReferenceSchema,
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  cacheReadTokens: tokenCountSchema,
  cacheWriteTokens: tokenCountSchema,
});

export type ReportedModelUsage = z.infer<typeof reportedModelUsageSchema>;

const totalSchema = z.int().nonnegative();

/** Tokens used on one model, counted one way, added up over a period. */
export const modelUsageTotalsSchema = z.strictObject({
  providerId: modelProviderIdSchema,
  modelId: z.string().min(1),
  source: modelUsageSourceSchema,
  inputTokens: totalSchema,
  outputTokens: totalSchema,
  cacheReadTokens: totalSchema,
  cacheWriteTokens: totalSchema,
  /** How many answers these are. */
  answerCount: totalSchema,
});

export type ModelUsageTotals = z.infer<typeof modelUsageTotalsSchema>;

/** A cap of tokens counted at the proxy over the window. */
export const usageCapTokensSchema = z.int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * `GET /api/model-usage`: the signed-in user's usage over the last
 * `recentDays` days, by model, and their cap.
 */
export const userModelUsageResponseSchema = z.strictObject({
  cap: z.strictObject({
    /** The cap counts tokens used over this many hours, ending now. */
    windowHours: z.int().positive(),
    /** The installation's cap on every user, or null for none. */
    installationCapTokens: usageCapTokensSchema.nullable(),
    /** The user's own lower cap, or null for none. */
    ownCapTokens: usageCapTokensSchema.nullable(),
    /** Measured and estimated tokens within the window, which the cap counts. */
    countedTokensInWindow: totalSchema,
  }),
  recentDays: z.int().positive(),
  byModel: z.array(modelUsageTotalsSchema),
});

export type UserModelUsageResponse = z.infer<typeof userModelUsageResponseSchema>;

/** `GET /api/threads/{threadId}/model-usage`: everything the thread has used, by model. */
export const threadModelUsageResponseSchema = z.strictObject({
  byModel: z.array(modelUsageTotalsSchema),
});

export type ThreadModelUsageResponse = z.infer<typeof threadModelUsageResponseSchema>;

/**
 * `PUT /api/model-usage/own-cap`: sets the user's own cap, or removes it
 * with null. It may not be above the installation's (400 if it is).
 */
export const changeOwnUsageCapRequestSchema = z.strictObject({
  tokens: usageCapTokensSchema.nullable(),
});

export type ChangeOwnUsageCapRequest = z.infer<typeof changeOwnUsageCapRequestSchema>;

export const modelUsageApiPath = "/api/model-usage";
export const ownUsageCapApiPath = "/api/model-usage/own-cap";

export function buildThreadModelUsageApiPath(threadId: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}/model-usage`;
}

/** Input, output and cache tokens together: what the cap counts. */
export function countTokens(
  totals: Pick<
    ModelUsageTotals,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
  >,
): number {
  return (
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  );
}
