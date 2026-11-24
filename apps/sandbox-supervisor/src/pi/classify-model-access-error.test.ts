import { describe, expect, it } from "vitest";
import { classifyModelAccessError } from "./classify-model-access-error.js";

/**
 * The first four are the error messages the pinned Pi reported against an
 * OpenAI-compatible model returning each of OpenAI's documented error
 * bodies (reproduced by the mock model server, and asserted end to end in
 * `pi-agent-harness.integration.test.ts`). Anthropic's two come from its
 * documentation, not from Pi.
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
  ])("recognises %s", (errorMessage, kind) => {
    expect(classifyModelAccessError(errorMessage)).toBe(kind);
  });

  it.each([
    '503: {"message":"The model is overloaded."}',
    "Connection error.: Proxy response (403) !== 200 when HTTP Tunneling (UND_ERR_ABORTED)",
    "Your input exceeds the context window of this model.",
  ])("leaves %s unclassified, for its own message to explain", (errorMessage) => {
    expect(classifyModelAccessError(errorMessage)).toBeUndefined();
  });
});
