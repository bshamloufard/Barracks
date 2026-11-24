import { describe, expect, it } from "vitest";
import { reconnectDelayInMilliseconds } from "./reconnect-delay";

const alwaysLongest = () => 1;
const alwaysShortest = () => 0;

describe("the reconnect delay", () => {
  it("doubles with each attempt", () => {
    const delays = [0, 1, 2, 3].map((attempt) =>
      reconnectDelayInMilliseconds(attempt, alwaysLongest),
    );

    expect(delays).toEqual([500, 1000, 2000, 4000]);
  });

  it("never exceeds ten seconds", () => {
    expect(reconnectDelayInMilliseconds(30, alwaysLongest)).toBe(10_000);
  });

  it("is spread over the upper half of the capped delay", () => {
    expect(reconnectDelayInMilliseconds(1, alwaysShortest)).toBe(500);
    expect(reconnectDelayInMilliseconds(1, alwaysLongest)).toBe(1000);
  });
});
