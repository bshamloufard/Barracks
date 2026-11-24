import { describe, expect, it } from "vitest";
import { describeDuration, summarizeToolArguments } from "./describe-tool-execution";

describe("a tool arguments summary", () => {
  it("is the argument itself when there is a single text argument", () => {
    expect(summarizeToolArguments({ command: "ls -la" })).toBe("ls -la");
  });

  it("is compact JSON when there are several arguments", () => {
    expect(summarizeToolArguments({ path: "a.txt", limit: 10 })).toBe(
      '{"path":"a.txt","limit":10}',
    );
  });

  it("fits on one line", () => {
    expect(summarizeToolArguments({ command: "echo one\n  echo two" })).toBe("echo one echo two");
  });

  it("is cut short with an ellipsis when it is long", () => {
    const summary = summarizeToolArguments({ command: "x".repeat(500) });

    expect(summary).toHaveLength(120);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("a duration description", () => {
  it("uses milliseconds below a second and seconds above", () => {
    expect(describeDuration(42)).toBe("42 ms");
    expect(describeDuration(1234)).toBe("1.2 s");
  });
});
