import { describe, expect, it } from "vitest";
import {
  chatGptPlanStatusSchema,
  completeChatGptPlanSignInRequestSchema,
  maximumFinalAddressLength,
  startChatGptPlanSignInRequestSchema,
} from "./chatgpt-plan.js";
import { configureModelAccessSchema } from "./model-access.js";

describe("a ChatGPT plan sign-in", () => {
  it("begins only with the user's consent to use the plan in the background", () => {
    expect(
      startChatGptPlanSignInRequestSchema.safeParse({ allowsBackgroundUse: true }).success,
    ).toBe(true);
    expect(
      startChatGptPlanSignInRequestSchema.safeParse({ allowsBackgroundUse: false }).success,
    ).toBe(false);
    expect(startChatGptPlanSignInRequestSchema.safeParse({}).success).toBe(false);
  });

  it("finishes with any text no longer than an address can be, which the control plane reads", () => {
    expect(
      completeChatGptPlanSignInRequestSchema.safeParse({ finalAddress: " not an address " })
        .success,
    ).toBe(true);
    expect(
      completeChatGptPlanSignInRequestSchema.safeParse({
        finalAddress: "x".repeat(maximumFinalAddressLength + 1),
      }).success,
    ).toBe(false);
  });

  it("is described to a client without anything of its tokens", () => {
    const status = {
      availability: "available",
      connection: { connectedAt: "2026-11-25T10:00:00.000Z", accountEmail: null },
      loss: null,
      openAiAccess: "chatgpt_plan",
    };

    expect(chatGptPlanStatusSchema.safeParse(status).success).toBe(true);
    expect(
      chatGptPlanStatusSchema.safeParse({ ...status, refreshToken: "a-refresh-token" }).success,
    ).toBe(false);
  });
});

describe("a model proxy token", () => {
  const proxyToken = {
    kind: "proxy_token",
    secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    baseUrl: "https://barrack.example.com/threads/thread-1/model-proxy/openai",
  };

  it("says whether the proxy spends the owner's API key or their ChatGPT plan", () => {
    for (const access of ["api_key", "chatgpt_plan"]) {
      expect(
        configureModelAccessSchema.safeParse({
          type: "configure_model_access",
          model: "openai/gpt-6.1-sol",
          credential: { ...proxyToken, access },
        }).success,
      ).toBe(true);
    }
  });

  it("is refused without saying so, as a supervisor of version 6 would send none", () => {
    expect(
      configureModelAccessSchema.safeParse({
        type: "configure_model_access",
        model: "openai/gpt-6.1-sol",
        credential: proxyToken,
      }).success,
    ).toBe(false);
  });
});
