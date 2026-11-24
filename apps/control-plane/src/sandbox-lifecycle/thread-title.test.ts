import { describe, expect, it } from "vitest";
import { deriveThreadTitle } from "./thread-title.js";

describe("a thread's title", () => {
  it("is the first line with any text, with its whitespace collapsed", () => {
    expect(deriveThreadTitle("\n  \n  Fix   the\tflaky test  \nIt fails one run in ten.")).toBe(
      "Fix the flaky test",
    );
  });

  it("is cut at a word boundary with an ellipsis when long", () => {
    const longLine = `Rewrite ${"the importer ".repeat(10)}to stream`;

    const title = deriveThreadTitle(longLine);

    expect(title?.length).toBeLessThanOrEqual(80);
    expect(title).toMatch(/^Rewrite (the importer )+the…$/);
  });

  it("is cut mid-word only when a single word fills most of the length", () => {
    const title = deriveThreadTitle("x".repeat(200));

    expect(title).toBe(`${"x".repeat(79)}…`);
  });

  it("is nothing for a message with no text, so the next message gives it", () => {
    expect(deriveThreadTitle(" \n\t\n ")).toBeUndefined();
  });
});
