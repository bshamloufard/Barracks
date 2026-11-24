import type { ToolArguments } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import { summarizeToolCall } from "./describe-tool-execution";

function describeComputerCall(toolArguments: ToolArguments): string {
  return summarizeToolCall("computer", toolArguments);
}

describe("a computer tool call", () => {
  it("is put in words, so the history says what the agent did on the desktop", () => {
    expect(describeComputerCall({ action: "screenshot" })).toBe("Looked at the screen");
    expect(describeComputerCall({ action: "left_click", coordinate: [400, 383] })).toBe(
      "Clicked at (400, 383)",
    );
    expect(describeComputerCall({ action: "double_click", coordinate: [1, 2] })).toBe(
      "Double-clicked at (1, 2)",
    );
    expect(
      describeComputerCall({
        action: "left_click_drag",
        start_coordinate: [1, 2],
        coordinate: [3, 4],
      }),
    ).toBe("Dragged from (1, 2) to (3, 4)");
    expect(
      describeComputerCall({ action: "scroll", coordinate: [5, 6], scroll_direction: "up" }),
    ).toBe("Scrolled up at (5, 6)");
    expect(describeComputerCall({ action: "type", text: "hello\nworld" })).toBe(
      "Typed “hello world”",
    );
    expect(describeComputerCall({ action: "key", text: "ctrl+l" })).toBe("Pressed ctrl+l");
    expect(describeComputerCall({ action: "wait", duration: 5 })).toBe("Waited 5 s");
  });

  it("falls back to the arguments for an action this page does not know, and for other tools", () => {
    expect(describeComputerCall({ action: "zoom" })).toBe("zoom");
    expect(summarizeToolCall("bash", { command: "ls" })).toBe("ls");
  });
});
