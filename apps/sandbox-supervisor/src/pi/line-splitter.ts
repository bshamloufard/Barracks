const lineFeed = 0x0a;
const carriageReturn = 0x0d;

export type LineSplitterOptions = {
  /**
   * Keeps at most this many bytes of any one line and replaces the rest with
   * a marker. Leave it unset where a cut line would be useless, as with
   * Pi's JSONL records.
   */
  maximumLineLengthInBytes?: number;
};

/**
 * Splits a byte stream into lines at `\n` and nothing else. Pi's stdout is
 * JSONL, and Node's `readline` also breaks lines at U+2028 and U+2029, which
 * may appear unescaped inside JSON strings, so it would cut records in half.
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
 *
 * Splitting bytes rather than decoded text also keeps a multi-byte character
 * that straddles two chunks intact.
 *
 * The pieces of an unfinished line are collected and joined once, when its
 * line feed arrives. Pi's `agent_end` record repeats a whole run, base64
 * images included, so one line can be megabytes long and arrive in many
 * chunks; joining on every chunk would copy it over and over.
 */
export class LineSplitter {
  readonly #maximumLineLengthInBytes: number;
  #unfinishedLinePieces: Buffer[] = [];
  #keptByteCount = 0;
  #omittedByteCount = 0;

  constructor(options: LineSplitterOptions = {}) {
    this.#maximumLineLengthInBytes = options.maximumLineLengthInBytes ?? Number.POSITIVE_INFINITY;
  }

  /** Returns the lines completed by this chunk, without their line endings. */
  push(chunk: Buffer): string[] {
    const completedLines: string[] = [];
    let lineStart = 0;
    let lineFeedIndex = chunk.indexOf(lineFeed);
    while (lineFeedIndex !== -1) {
      this.#keep(chunk.subarray(lineStart, lineFeedIndex));
      completedLines.push(this.#takeLine());
      lineStart = lineFeedIndex + 1;
      lineFeedIndex = chunk.indexOf(lineFeed, lineStart);
    }
    this.#keep(chunk.subarray(lineStart));
    return completedLines;
  }

  /** Bytes received after the last line feed, which a well-behaved writer never leaves. */
  get unfinishedLineLength(): number {
    return this.#keptByteCount + this.#omittedByteCount;
  }

  #keep(piece: Buffer): void {
    const room = this.#maximumLineLengthInBytes - this.#keptByteCount;
    const keptPiece = piece.length > room ? piece.subarray(0, room) : piece;
    this.#omittedByteCount += piece.length - keptPiece.length;
    if (keptPiece.length > 0) {
      this.#unfinishedLinePieces.push(keptPiece);
      this.#keptByteCount += keptPiece.length;
    }
  }

  #takeLine(): string {
    const line = decodeLine(Buffer.concat(this.#unfinishedLinePieces, this.#keptByteCount));
    const omissionMarker =
      this.#omittedByteCount === 0 ? "" : ` [… ${this.#omittedByteCount} more bytes not kept]`;
    this.#unfinishedLinePieces = [];
    this.#keptByteCount = 0;
    this.#omittedByteCount = 0;
    return `${line}${omissionMarker}`;
  }
}

/** Pi's framing allows an optional `\r` before the `\n`. */
function decodeLine(line: Buffer): string {
  const withoutCarriageReturn = line.at(-1) === carriageReturn ? line.subarray(0, -1) : line;
  return withoutCarriageReturn.toString("utf8");
}
