import { maximumToolOutputLength, type ToolOutput } from "@barrack/protocol";
import { shortenText } from "../shorten-text.js";
import type { PiToolResultContentBlock } from "./pi-records.js";

/**
 * Tool results are stored as text. Images are not forwarded (the model has
 * already seen them, and base64 data would dwarf the rest of the history);
 * a placeholder records that one was there.
 */
export function flattenToolResultContent(content: PiToolResultContentBlock[]): string {
  return content.map(describeToolResultContentBlock).join("\n");
}

function describeToolResultContentBlock(block: PiToolResultContentBlock): string {
  if ("unrecognized" in block) {
    return `[${block.unrecognized} content]`;
  }
  if (block.type === "image") {
    return `[image: ${block.mimeType}]`;
  }
  return block.text;
}

/**
 * Share of the kept text taken from the start of the output; the rest comes
 * from the end. The end of command output is usually what matters most
 * (errors, exit status, test and build summaries), while the start shows what
 * the command was doing, so both are kept and the middle is cut.
 */
const keptShareFromStart = 0.25;

export function truncateToolOutput(
  text: string,
  maximumLength: number = maximumToolOutputLength,
): ToolOutput {
  const originalSizeInBytes = Buffer.byteLength(text, "utf8");
  if (text.length <= maximumLength) {
    return { text, isTruncated: false, originalSizeInBytes };
  }
  return {
    text: shortenText(text, maximumLength, keptShareFromStart),
    isTruncated: true,
    originalSizeInBytes,
  };
}
