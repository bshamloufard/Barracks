import { describe, expect, it } from "vitest";
import { protocolVersion } from "./protocol-version.js";

describe("protocolVersion", () => {
  it("is a positive integer so peers can compare versions numerically", () => {
    expect(Number.isInteger(protocolVersion)).toBe(true);
    expect(protocolVersion).toBeGreaterThan(0);
  });

  it("is 4, the first version in which each user brings their own model access", () => {
    expect(protocolVersion).toBe(4);
  });
});
