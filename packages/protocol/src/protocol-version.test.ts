import { describe, expect, it } from "vitest";
import { protocolVersion } from "./protocol-version.js";

describe("protocolVersion", () => {
  it("is a positive integer so peers can compare versions numerically", () => {
    expect(Number.isInteger(protocolVersion)).toBe(true);
    expect(protocolVersion).toBeGreaterThan(0);
  });

  it("is 5, the first version with the live desktop", () => {
    expect(protocolVersion).toBe(5);
  });
});
