import { describe, expect, it } from "vitest";
import { closeCodes } from "./close-codes.js";

describe("closeCodes", () => {
  const codes = Object.values(closeCodes);

  it("uses only the range WebSocket reserves for applications", () => {
    for (const code of codes) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4999);
    }
  });

  it("gives every reason its own code", () => {
    expect(new Set(codes).size).toBe(codes.length);
  });
});
