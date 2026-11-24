import type { ToolArguments } from "@barrack/protocol";

const longestArgumentsSummaryLength = 120;

/**
 * One line that says what a tool was asked to do. Most tools take a single
 * main argument, such as a command or a path, which is clearer on its own
 * than as JSON.
 */
export function summarizeToolArguments(toolArguments: ToolArguments): string {
  const values = Object.values(toolArguments);
  const [onlyValue] = values;
  const summary =
    values.length === 1 && typeof onlyValue === "string"
      ? onlyValue
      : JSON.stringify(toolArguments);
  return shortenToOneLine(summary, longestArgumentsSummaryLength);
}

/**
 * One line for a tool call. The agent's computer tool is put in words
 * ("Clicked at (400, 383)"), since its history keeps no screenshots: the
 * user watches the desktop itself.
 */
export function summarizeToolCall(toolName: string, toolArguments: ToolArguments): string {
  const computerAction =
    toolName === "computer" ? describeComputerAction(toolArguments) : undefined;
  return computerAction ?? summarizeToolArguments(toolArguments);
}

/** Undefined for arguments that are not a computer action this page knows. */
export function describeComputerAction(toolArguments: ToolArguments): string | undefined {
  const { action, coordinate, start_coordinate, text, scroll_direction, duration } = toolArguments;
  const at = describePoint(coordinate);
  switch (action) {
    case "screenshot":
      return "Looked at the screen";
    case "left_click":
      return `Clicked at ${at}`;
    case "right_click":
      return `Right-clicked at ${at}`;
    case "middle_click":
      return `Middle-clicked at ${at}`;
    case "double_click":
      return `Double-clicked at ${at}`;
    case "mouse_move":
      return `Moved the mouse to ${at}`;
    case "left_click_drag":
      return `Dragged from ${describePoint(start_coordinate)} to ${at}`;
    case "scroll":
      return `Scrolled ${typeof scroll_direction === "string" ? scroll_direction : "down"} at ${at}`;
    case "type":
      return `Typed “${shortenToOneLine(String(text ?? ""), longestArgumentsSummaryLength)}”`;
    case "key":
      return `Pressed ${String(text ?? "")}`;
    case "wait":
      return `Waited ${typeof duration === "number" ? duration : 1} s`;
    default:
      return undefined;
  }
}

function describePoint(point: unknown): string {
  return Array.isArray(point) && point.length === 2 ? `(${point[0]}, ${point[1]})` : "(?)";
}

export function describeDuration(durationInMilliseconds: number): string {
  if (durationInMilliseconds < 1000) {
    return `${durationInMilliseconds} ms`;
  }
  return `${(durationInMilliseconds / 1000).toFixed(1)} s`;
}

function shortenToOneLine(text: string, longestLength: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= longestLength) {
    return oneLine;
  }
  return `${oneLine.slice(0, longestLength - 1)}…`;
}
