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
 * `local-model-proxy.test.ts`.
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
