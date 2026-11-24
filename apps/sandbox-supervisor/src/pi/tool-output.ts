import { maximumToolOutputLength, type ToolOutput } from "@barrack/protocol";
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
  // Reserve room for the longest marker this text could need.
  const markerLength = describeOmission(text.length).length;
  const keptLength = maximumLength - markerLength;
  // A cut between the two halves of a UTF-16 surrogate pair (an emoji, say)
  // would leave half a character behind, so such cuts move outwards by one,
  // which only ever shortens the kept text.
  let startEnd = Math.floor(keptLength * keptShareFromStart);
  if (isInsideSurrogatePair(text, startEnd)) {
    startEnd -= 1;
  }
  let tailStart = text.length - (keptLength - startEnd);
  if (isInsideSurrogatePair(text, tailStart)) {
    tailStart += 1;
  }
  const truncatedText =
    text.slice(0, startEnd) + describeOmission(tailStart - startEnd) + text.slice(tailStart);
  return { text: truncatedText, isTruncated: true, originalSizeInBytes };
}

function describeOmission(omittedCharacterCount: number): string {
  return `\n\n[… ${omittedCharacterCount} characters omitted …]\n\n`;
}

function isInsideSurrogatePair(text: string, cutIndex: number): boolean {
  return (
    isHighSurrogate(text.charCodeAt(cutIndex - 1)) && isLowSurrogate(text.charCodeAt(cutIndex))
  );
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
