const lineFeed = 0x0a;
const carriageReturn = 0x0d;

/**
 * Splits a byte stream into lines at `\n` and nothing else. Pi's stdout is
 * JSONL, and Node's `readline` also breaks lines at U+2028 and U+2029, which
 * may appear unescaped inside JSON strings, so it would cut records in half.
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
 *
 * Splitting bytes rather than decoded text also keeps a multi-byte character
 * that straddles two chunks intact.
 */
export class LineSplitter {
  #unfinishedLine: Buffer = Buffer.alloc(0);

  /** Returns the lines completed by this chunk, without their line endings. */
  push(chunk: Buffer): string[] {
    const completedLines: string[] = [];
    let remaining = Buffer.concat([this.#unfinishedLine, chunk]);
    let lineFeedIndex = remaining.indexOf(lineFeed);
    while (lineFeedIndex !== -1) {
      completedLines.push(decodeLine(remaining.subarray(0, lineFeedIndex)));
      remaining = remaining.subarray(lineFeedIndex + 1);
      lineFeedIndex = remaining.indexOf(lineFeed);
    }
    this.#unfinishedLine = remaining;
    return completedLines;
  }

  /** Bytes received after the last line feed, which a well-behaved writer never leaves. */
  get unfinishedLineLength(): number {
    return this.#unfinishedLine.length;
  }
}

/** Pi's framing allows an optional `\r` before the `\n`. */
function decodeLine(line: Buffer): string {
  const withoutCarriageReturn = line.at(-1) === carriageReturn ? line.subarray(0, -1) : line;
  return withoutCarriageReturn.toString("utf8");
}
