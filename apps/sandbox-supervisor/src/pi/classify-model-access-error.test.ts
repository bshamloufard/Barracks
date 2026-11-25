import { describe, expect, it } from "vitest";
import { classifyModelAccessError } from "./classify-model-access-error.js";

/**
 * The first four are the error messages the pinned Pi reported against an
 * OpenAI-compatible model returning each of OpenAI's documented error
 * bodies (reproduced by the mock model server, and asserted end to end in
 * `pi-agent-harness.integration.test.ts`). Anthropic's two come from its
 * documentation, not from Pi. The control plane model proxy's own refusals
 * are shaped as Anthropic's and OpenAI's errors are; the cap's was seen
 * through the proxy with the pinned Pi in `tests/end-to-end`'s
 * `local-model-proxy.test.ts`. The ChatGPT plan's are written as Pi
 * reports OpenAI's errors, with the codes OpenAI's programme documents;
 * `chatgpt-plan.test.ts` there sees them through the proxy.
 */
describe("classifying the model provider's errors", () => {
  it.each([
    [
      '401: {"message":"Incorrect API key provided: sk-abc***xyz.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}',
      "credential_rejected",
    ],
    [
      '429: {"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}',
      "quota_exhausted",
    ],
    [
      '429: {"message":"Rate limit reached for requests","type":"requests","param":null,"code":"rate_limit_exceeded"}',
      "rate_limited",
    ],
    ["Provider is not configured: mock", "credential_missing"],
    ["No API key found for the selected model.", "credential_missing"],
    [
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
      "quota_exhausted",
    ],
    [
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      "credential_rejected",
    ],
    [
      '403 {"type":"error","error":{"type":"permission_error","message":"You have reached your model usage cap: 12 of 10 tokens in the last 24 hours. Wait for older usage to leave that window, or raise your own cap in Settings, under Model usage."}}',
      "usage_cap_reached",
    ],
    [
      `403: {"message":"No API key found for the provider \\"openai\\" among the thread owner's keys in Barrack.","type":"permission_error","code":null}`,
      "credential_missing",
    ],
    [
      'OpenAI API error (429): 429 {"error":{"message":"Usage limit reached.","type":"usage_limit","code":"subscription_sharing_usage_limit_exceeded"}}\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage',
      "plan_limit_reached",
    ],
    [
      'OpenAI API error (403): 403 {"error":{"message":"Not eligible.","type":"permission_error","code":"subscription_sharing_user_not_eligible"}}',
      "plan_not_eligible",
    ],
    [
      'OpenAI API error (400): 400 {"error":{"message":"Unsupported.","type":"invalid_request_error","param":"model","code":"subscription_sharing_unsupported_capability"}}',
      "plan_capability_unsupported",
    ],
    [
      'OpenAI API error (401): 401 {"error":{"message":"Invalid user.","type":"invalid_request_error","code":"subscription_sharing_invalid_user"}}',
      "plan_sign_in_expired",
    ],
    [
      `403: {"message":"Your ChatGPT plan is not connected to Barrack: its sign-in expired or was revoked. Connect your ChatGPT plan again in Settings, then send your message again.","type":"permission_error","code":null}`,
      "plan_sign_in_expired",
    ],
    [
      `401: {"type":"error","error":{"type":"authentication_error","message":"OpenAI did not accept your ChatGPT plan's sign-in for this request, even renewed. If it happens again, disconnect your ChatGPT plan in Settings and connect it again, then send your message again."}}`,
      "plan_sign_in_expired",
    ],
    [
      'OpenAI API error (403): 403 {"error":{"message":"Not authorized.","type":"invalid_request_error","code":"chatpass_v2_scope_not_authorized"}}',
      "plan_sign_in_expired",
    ],
    [
      'OpenAI API error (403): 403 {"error":{"message":"Not authorized.","type":"invalid_request_error","code":"chatpass_v2_invalid_authorization_context"}}',
      "plan_sign_in_expired",
    ],
  ])("recognises %s", (errorMessage, kind) => {
    expect(classifyModelAccessError(errorMessage)).toBe(kind);
  });

  it.each([
    '503: {"message":"The model is overloaded."}',
    "Connection error.: Proxy response (403) !== 200 when HTTP Tunneling (UND_ERR_ABORTED)",
    "Your input exceeds the context window of this model.",
    `403 {"type":"error","error":{"type":"permission_error","message":"Barrack's model proxy does not accept this sandbox's token for this thread and provider: the thread is not running, it now runs on another provider, or its token was revoked."}}`,
  ])("leaves %s unclassified, for its own message to explain", (errorMessage) => {
    expect(classifyModelAccessError(errorMessage)).toBeUndefined();
  });
});
