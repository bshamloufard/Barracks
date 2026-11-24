import { maximumToolOutputLength } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import { flattenToolResultContent, truncateToolOutput } from "./tool-output.js";

describe("flattenToolResultContent", () => {
  it("joins text blocks and replaces images with a placeholder", () => {
    const text = flattenToolResultContent([
      { type: "text", text: "Screenshot taken" },
      { type: "image", mimeType: "image/png" },
      { unrecognized: "audio" },
    ]);

    expect(text).toBe("Screenshot taken\n[image: image/png]\n[audio content]");
  });
});

describe("truncateToolOutput", () => {
  it("keeps output within the limit unchanged and records its size in bytes", () => {
    expect(truncateToolOutput("héllo")).toEqual({
      text: "héllo",
      isTruncated: false,
      originalSizeInBytes: 6,
    });
  });

  it("cuts long output to the protocol's limit and records the original size", () => {
    const output = "x".repeat(maximumToolOutputLength * 3);

    const truncated = truncateToolOutput(output);

    expect(truncated.isTruncated).toBe(true);
    expect(truncated.text.length).toBeLessThanOrEqual(maximumToolOutputLength);
    expect(truncated.originalSizeInBytes).toBe(maximumToolOutputLength * 3);
  });

  it("keeps the start and, mostly, the end of long output and says how much was left out", () => {
    const output = `START ${"middle ".repeat(1_000)} END`;

    const truncated = truncateToolOutput(output, 400);

    expect(truncated.text.startsWith("START ")).toBe(true);
    expect(truncated.text.endsWith(" END")).toBe(true);
    expect(truncated.text).toMatch(/\[… \d+ characters omitted …\]/);
    const [kept] = truncated.text.split("[…");
    expect(kept?.length).toBeLessThan(truncated.text.length / 2);
  });

  it("never leaves half of a character that takes two UTF-16 units", () => {
    for (let maximumLength = 60; maximumLength < 70; maximumLength += 1) {
      const truncated = truncateToolOutput("😀".repeat(200), maximumLength);

      expect(truncated.text.length).toBeLessThanOrEqual(maximumLength);
      expect(truncated.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
      expect(truncated.text).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
    }
  });
});
