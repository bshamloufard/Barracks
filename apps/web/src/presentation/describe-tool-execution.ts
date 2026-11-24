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
