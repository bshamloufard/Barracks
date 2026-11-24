import type { ModelUsageTotals } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import { describeKeyPlacement, describeUsageTotal, keyPlacementOf } from "./describe-model-usage";

const totals = (source: ModelUsageTotals["source"], inputTokens: number): ModelUsageTotals => ({
  providerId: "anthropic",
  modelId: "model-a",
  source,
  inputTokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  answerCount: 1,
});

describe("describing model usage", () => {
  it("keeps what Barrack counted apart from what the sandbox reported", () => {
    expect(
      describeUsageTotal([
        totals("measured", 1_000),
        totals("estimated", 200),
        totals("reported", 30),
      ]),
    ).toBe("1,200 tokens counted by Barrack, and 30 tokens reported by the sandbox");
    expect(describeUsageTotal([])).toBe("No usage yet");
  });

  it("says plainly where each kind of key lives, and that a provider it does not know keeps it in the sandbox", () => {
    expect(describeKeyPlacement("kept_on_server").label).toBe("Your key stays on the server");
    expect(describeKeyPlacement("placed_in_sandbox").explanation).toContain(
      "the agent and any code it runs can read it",
    );
    expect(keyPlacementOf(undefined, "someone-elses")).toBe("placed_in_sandbox");
  });
});
