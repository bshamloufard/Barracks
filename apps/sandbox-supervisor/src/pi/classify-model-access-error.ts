import type { ModelAccessErrorKind } from "@barrack/protocol";

/**
 * Recognises, in the error text Pi reports for a failed model request, the
 * failures a user can act on, so clients can say what happened and what to
 * do without reading a provider's wording themselves.
 *
 * Pi reports a provider's refusal as the assistant message's `errorMessage`:
 * the HTTP status and the provider's error body, such as
 * `401: {"message":"Incorrect API key provided…","code":"invalid_api_key"}`
 * from an OpenAI-compatible API, and its own words when it has no
 * credential: `Provider is not configured: <provider>` once a key is gone,
 * `No API key found for …` for a prompt refused before any request.
 * Each pattern below was seen from the pinned Pi against the mock model
 * server (see `pi-agent-harness.integration.test.ts`), except the wording
 * of providers that mock does not imitate, which comes from their own
 * documentation and is marked so.
 *
 * Quota comes before the rest because providers send it with status 429,
 * like a rate limit, and it needs the opposite advice: waiting does not
 * help. The phrases are those Pi itself treats as exhausted quota rather
 * than a passing failure (`NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` in
 * pi-ai's `utils/retry.js`), plus Anthropic's.
 */

const credentialMissingPattern = /provider is not configured|no api key found/i;

/**
 * Barrack's own refusal, from the control plane's model proxy, once the
 * thread's owner has reached their usage cap: it says "model usage cap"
 * for this, and comes as a status the agent does not retry.
 */
const usageCapReachedPattern = /model usage cap/i;

const quotaExhaustedPattern = new RegExp(
  [
    "insufficient_quota",
    "quota exceeded",
    "exceeded your current quota",
    "out of budget",
    "billing",
    "available balance",
    "usage limit reached",
    "UsageLimitError",
    "subscription_sharing_usage_limit_exceeded",
    "subscription_sharing_workplace_individual_usage_limit_exceeded",
    // Anthropic, from its documentation: "Your credit balance is too low…".
    "credit balance is too low",
  ].join("|"),
  "i",
);

const credentialRejectedPattern = new RegExp(
  [
    "invalid_api_key",
    "incorrect api key",
    "invalid api key",
    "invalid x-api-key",
    "authentication_error",
    "authentication failed",
    "unauthorized",
    // A status at the start, as Pi writes it, such as `401: {…}`.
    "^\\s*401\\b",
  ].join("|"),
  "i",
);

const rateLimitedPattern = /rate.?limit|too many requests|^\s*429\b|resource.?exhausted/i;

export function classifyModelAccessError(errorMessage: string): ModelAccessErrorKind | undefined {
  if (usageCapReachedPattern.test(errorMessage)) {
    return "usage_cap_reached";
  }
  if (credentialMissingPattern.test(errorMessage)) {
    return "credential_missing";
  }
  if (quotaExhaustedPattern.test(errorMessage)) {
    return "quota_exhausted";
  }
  if (credentialRejectedPattern.test(errorMessage)) {
    return "credential_rejected";
  }
  if (rateLimitedPattern.test(errorMessage)) {
    return "rate_limited";
  }
  return undefined;
}
