import { describe, expect, it } from "vitest";
import { computeReconnectDelay } from "./reconnect-delay.js";

const settings = { initialDelayInMilliseconds: 500, maximumDelayInMilliseconds: 15_000 };

describe("computeReconnectDelay", () => {
  it("doubles the delay with each attempt", () => {
    const highestDelays = [0, 1, 2, 3].map((attempt) =>
      computeReconnectDelay(attempt, settings, () => 1),
    );

    expect(highestDelays).toEqual([500, 1_000, 2_000, 4_000]);
  });

  it("never waits longer than the maximum, however many attempts have failed", () => {
    expect(computeReconnectDelay(50, settings, () => 1)).toBe(15_000);
  });

  it("spreads delays between half and all of the current ceiling", () => {
    expect(computeReconnectDelay(2, settings, () => 0)).toBe(1_000);
    expect(computeReconnectDelay(2, settings, () => 0.5)).toBe(1_500);
  });
});
