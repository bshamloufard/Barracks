import { describe, expect, it } from "vitest";
import { protocolVersion } from "./protocol-version.js";

describe("protocolVersion", () => {
  it("is a positive integer so peers can compare versions numerically", () => {
    expect(Number.isInteger(protocolVersion)).toBe(true);
    expect(protocolVersion).toBeGreaterThan(0);
  });

  it("is 2, the first version with acknowledged delivery between supervisor and control plane", () => {
    expect(protocolVersion).toBe(2);
  });
});
