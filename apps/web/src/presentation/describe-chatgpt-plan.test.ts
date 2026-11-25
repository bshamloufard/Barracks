import type { ChatGptPlanStatus } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import { describeChatGptPlan, signInSteps } from "./describe-chatgpt-plan";

const formatDate = (isoDate: string) => isoDate.slice(0, 10);

const notConnected: ChatGptPlanStatus = {
  availability: "available",
  connection: null,
  loss: null,
  openAiAccess: "api_key",
};

describe("describing the user's ChatGPT plan in Settings", () => {
  it("says why the installation does not offer it, and that OpenAI models run on the key", () => {
    const description = describeChatGptPlan(
      { ...notConnected, availability: "turned_off" },
      formatDate,
    );

    expect(description.kind).toBe("turned_off");
    expect(description.kind === "turned_off" && description.explanation).toContain(
      "only on infrastructure the account holder controls",
    );
  });

  it("says a plan was lost, and when, so the user connects it again", () => {
    const description = describeChatGptPlan(
      { ...notConnected, loss: { reason: "sign_in_expired", at: "2026-11-25T10:00:00.000Z" } },
      formatDate,
    );

    expect(description).toEqual({
      kind: "not_connected",
      lossNotice: expect.stringContaining("expired or was revoked (2026-11-25)"),
    });
  });

  it("names the connected account and whether OpenAI models run on it", () => {
    const description = describeChatGptPlan(
      {
        ...notConnected,
        connection: { connectedAt: "2026-11-25T10:00:00.000Z", accountEmail: "ada@example.com" },
        openAiAccess: "chatgpt_plan",
      },
      formatDate,
    );

    expect(description).toEqual({
      kind: "connected",
      account: "ada@example.com",
      since: "2026-11-25",
      isInUse: true,
    });
  });

  it("warns before sign-in begins that the last page fails to load, and that it is expected", () => {
    expect(signInSteps.join(" ")).toContain("fails to load. That is expected");
  });
});
