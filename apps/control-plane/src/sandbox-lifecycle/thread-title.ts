/** Long enough to tell threads apart in a list, short enough for one line on a phone. */
const derivedTitleMaximumLength = 80;

/**
 * A thread's title is derived from its first user message: the first line
 * that has any text, with runs of whitespace made single spaces, cut at a
 * word boundary to fit `derivedTitleMaximumLength` with an ellipsis. A
 * message with no text at all gives no title, and the next one is tried.
 */
export function deriveThreadTitle(firstUserMessage: string): string | undefined {
  const firstLine = firstUserMessage
    .split(/\r?\n/)
    .map((line) => line.replaceAll(/\s+/g, " ").trim())
    .find((line) => line !== "");
  if (firstLine === undefined) {
    return undefined;
  }
  if (firstLine.length <= derivedTitleMaximumLength) {
    return firstLine;
  }
  const cut = firstLine.slice(0, derivedTitleMaximumLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const wordBoundaryCut =
    lastSpace >= derivedTitleMaximumLength / 2 ? cut.slice(0, lastSpace) : cut;
  return `${wordBoundaryCut.trimEnd()}…`;
}
