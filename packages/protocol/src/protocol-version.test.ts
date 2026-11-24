import { describe, expect, it } from "vitest";
import { protocolVersion } from "./protocol-version.js";

describe("protocolVersion", () => {
  it("is a positive integer so peers can compare versions numerically", () => {
    expect(Number.isInteger(protocolVersion)).toBe(true);
    expect(protocolVersion).toBeGreaterThan(0);
  });
});
