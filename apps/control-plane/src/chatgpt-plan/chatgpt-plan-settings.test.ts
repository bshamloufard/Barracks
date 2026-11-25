import { describe, expect, it } from "vitest";
import { readConfiguration } from "../configuration.js";

const supabaseEnvironment = {
  BARRACK_MODEL_CREDENTIAL_KEY: Buffer.alloc(32, 1).toString("base64"),
  BARRACK_SUPABASE_URL: "https://project-ref.supabase.co/",
  BARRACK_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  BARRACK_ALLOWED_USER_EMAILS: "owner@example.com",
  BARRACK_SANDBOX_PROVIDER: "docker",
  BARRACK_DOCKER_IMAGE: "barrack-sandbox:dev",
  BARRACK_SANDBOX_CONTROL_PLANE_URL: "ws://host.docker.internal:8787/",
  BARRACK_AGENT_HARNESS: "fake",
};

function chatGptPlanOf(environment: Record<string, string>) {
  const result = readConfiguration(environment);
  return result.ok ? result.configuration.chatGptPlan : result.problems;
}

describe("the ChatGPT plan setting", () => {
  it("is off unless the operator turns it on", () => {
    expect(chatGptPlanOf(supabaseEnvironment)).toEqual({ isOffered: false });
  });

  it("signs in at OpenAI once turned on where the installation admits its one user", () => {
    expect(chatGptPlanOf({ ...supabaseEnvironment, BARRACK_CHATGPT_PLAN_SIGN_IN: "on" })).toEqual({
      isOffered: true,
      issuer: "https://auth.openai.com",
    });
  });

  it.each([
    ["two listed addresses", "owner@example.com,friend@example.com"],
    ["everyone who can sign in", "anyone-who-can-sign-in"],
  ])("is refused where the installation admits %s, naming the reason", (_case, emails) => {
    const problems = chatGptPlanOf({
      ...supabaseEnvironment,
      BARRACK_ALLOWED_USER_EMAILS: emails,
      BARRACK_CHATGPT_PLAN_SIGN_IN: "on",
    });

    expect(problems).toEqual([expect.stringContaining("admits exactly one user")]);
  });

  it("refuses a stand-in for OpenAI's sign-in outside development mode without the second switch", () => {
    const standIn = {
      ...supabaseEnvironment,
      BARRACK_CHATGPT_PLAN_SIGN_IN: "on",
      BARRACK_CHATGPT_SIGN_IN_ISSUER: "development-only:http://127.0.0.1:4011",
    };

    expect(chatGptPlanOf(standIn)).toEqual([
      expect.stringContaining("hands the user's ChatGPT sign-in to that origin"),
    ]);
    expect(
      chatGptPlanOf({ ...standIn, BARRACK_ALLOW_UNSAFE_MODEL_PROXY_UPSTREAM: "development-only" }),
    ).toEqual({ isOffered: true, issuer: "http://127.0.0.1:4011" });
  });

  it("refuses any other value", () => {
    expect(chatGptPlanOf({ ...supabaseEnvironment, BARRACK_CHATGPT_PLAN_SIGN_IN: "yes" })).toEqual([
      'BARRACK_CHATGPT_PLAN_SIGN_IN: must be "off" (the default) or "on"',
    ]);
  });
});
