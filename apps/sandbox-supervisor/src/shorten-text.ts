/**
 * Cuts the middle out of `text` so that it is at most `maximumLength`
 * characters long, marker included, keeping `keptShareFromStart` of what
 * remains from the start and the rest from the end. Text that already fits
 * is returned unchanged.
 */
export function shortenText(
  text: string,
  maximumLength: number,
  keptShareFromStart: number,
): string {
  if (text.length <= maximumLength) {
    return text;
  }
  // Reserve room for the longest marker this text could need.
  const markerLength = describeOmission(text.length).length;
  const keptLength = Math.max(0, maximumLength - markerLength);
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
  return text.slice(0, startEnd) + describeOmission(tailStart - startEnd) + text.slice(tailStart);
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
