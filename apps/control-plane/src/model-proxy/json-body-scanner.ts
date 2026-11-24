/**
 * Checks a request body as it arrives, chunk by chunk, against JSON's own
 * grammar (RFC 8259: strict, no comments, no trailing commas, nothing
 * after the value), and notes where each member of the top-level object
 * lies, so the proxy can read the few members it needs without parsing the
 * rest. Its work is a single pass over each byte as it arrives, with
 * nothing allocated per value, so no body, of any shape, costs the event
 * loop more than a pass over its bytes, spread over its chunks; and what it
 * keeps grows only with the nesting depth, which it bounds.
 *
 * Bytes it does not need to understand pass through it unexamined but for
 * the grammar: everything the proxy relays unread is valid JSON, so any
 * conforming parser at the provider finds the same top-level members.
 *
 * It also measures what an estimate of the body's input tokens needs (see
 * `answer-usage.ts`): the whitespace between tokens, which no provider
 * counts, and the images the body sends, whose base64 data a provider
 * counts by the picture's size rather than by its bytes.
 */

export type JsonBodyScannerLimits = {
  /** The deepest nesting accepted; the pinned agent's requests nest about a dozen deep. */
  maximumDepth: number;
  /** The most members the top-level object may have; the agent's requests have about ten. */
  maximumTopLevelMembers: number;
  /** The longest top-level key accepted, in bytes. */
  maximumTopLevelKeyBytes: number;
};

/** Where one member of the top-level object lies, as byte offsets into the body. */
export type TopLevelMember = {
  /** The key's opening quote. */
  keyStart: number;
  /** Just after the key's closing quote. */
  keyEnd: number;
  valueStart: number;
  /** Just after the value. */
  valueEnd: number;
};

export type ScannedJsonBody = {
  members: TopLevelMember[];
  /** The offset of the top-level object's closing brace. */
  closingBraceOffset: number;
  /** Whitespace between tokens, in bytes. */
  insignificantBytes: number;
  /** Bytes of base64 image data, in data URLs or Anthropic's base64 image sources. */
  base64ImageBytes: number;
  /** Images the body sends or refers to, however it does. */
  imageCount: number;
};

export type JsonScanOutcome = { kind: "scanned"; body: ScannedJsonBody } | JsonScanProblem;

export type JsonScanProblem = { kind: "invalid"; reason: string };

const expecting = {
  value: 0,
  valueOrArrayEnd: 1,
  keyOrObjectEnd: 2,
  key: 3,
  colon: 4,
  commaOrEnd: 5,
  nothingMore: 6,
  stringContent: 7,
  stringEscape: 8,
  unicodeEscapeDigits: 9,
  digitAfterMinus: 10,
  afterLeadingZero: 11,
  integerDigits: 12,
  digitAfterPoint: 13,
  fractionDigits: 14,
  exponentSignOrDigit: 15,
  digitAfterExponentSign: 16,
  exponentDigits: 17,
  literalLetters: 18,
} as const;

type Expecting = (typeof expecting)[keyof typeof expecting];

const byte = {
  tab: 0x09,
  lineFeed: 0x0a,
  carriageReturn: 0x0d,
  space: 0x20,
  quote: 0x22,
  plus: 0x2b,
  comma: 0x2c,
  minus: 0x2d,
  point: 0x2e,
  zero: 0x30,
  nine: 0x39,
  colon: 0x3a,
  openBracket: 0x5b,
  backslash: 0x5c,
  closeBracket: 0x5d,
  openBrace: 0x7b,
  closeBrace: 0x7d,
  upperE: 0x45,
  lowerE: 0x65,
} as const;

const literals: Record<number, Buffer> = {
  [0x74]: Buffer.from("rue"),
  [0x66]: Buffer.from("alse"),
  [0x6e]: Buffer.from("ull"),
};

/** The characters a JSON string escape may name after its backslash. */
const escapeLetters = new Set(Buffer.from('"\\/bfnrtu'));

const base64Alphabet = new Uint8Array(256);
for (const character of Buffer.from(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
)) {
  base64Alphabet[character] = 1;
}

const hexDigits = new Uint8Array(256);
for (const character of Buffer.from("0123456789abcdefABCDEF")) {
  hexDigits[character] = 1;
}

/** Enough of each string's start to recognise the keys and values that mark images. */
const stringPrefixCapacity = 48;

/** Keys whose values tell about images; any other key is `otherKey`. */
const keyKinds = { otherKey: 0, type: 1, data: 2, mediaType: 3 } as const;
const recognisedKeys: ReadonlyArray<[Buffer, number]> = [
  [Buffer.from("type"), keyKinds.type],
  [Buffer.from("data"), keyKinds.data],
  [Buffer.from("media_type"), keyKinds.mediaType],
];

/**
 * The `type` of an image part in each relayed format: Anthropic's `image`,
 * the Responses API's `input_image`, Chat Completions' `image_url`.
 */
const imageTypes = [Buffer.from("image"), Buffer.from("input_image"), Buffer.from("image_url")];
const imageMediaTypePrefix = Buffer.from("image/");
const imageDataUrlPrefix = Buffer.from("data:image/");
const base64Marker = Buffer.from(";base64,");

/** Shorter base64 than this is no picture worth estimating apart. */
const shortestImageData = 64;

export class JsonBodyScanner {
  readonly #limits: JsonBodyScannerLimits;
  #expecting: Expecting = expecting.value;
  #problem: JsonScanProblem | undefined;
  /** The offset of the first byte of the chunk being scanned. */
  #chunkOffset = 0;
  #depth = 0;
  readonly #isObjectAt: Uint8Array;
  readonly #keyKindAt: Uint8Array;
  readonly #hasImageMediaTypeAt: Uint8Array;
  readonly #pendingBase64BytesAt: Float64Array;
  // The string being read.
  #isKey = false;
  #stringLength = 0;
  #lastNonBase64Position = -1;
  readonly #stringPrefix = Buffer.alloc(stringPrefixCapacity);
  #stringPrefixLength = 0;
  #unicodeDigitsLeft = 0;
  // The literal being read.
  #literal: Buffer = literals[0x74] as Buffer;
  #literalPosition = 0;
  // What the scan found.
  readonly #members: TopLevelMember[] = [];
  #member: TopLevelMember = { keyStart: 0, keyEnd: 0, valueStart: 0, valueEnd: 0 };
  #closingBraceOffset = 0;
  #insignificantBytes = 0;
  #base64ImageBytes = 0;
  #base64Images = 0;
  #imageTypeMarks = 0;

  constructor(limits: JsonBodyScannerLimits) {
    this.#limits = limits;
    this.#isObjectAt = new Uint8Array(limits.maximumDepth + 1);
    this.#keyKindAt = new Uint8Array(limits.maximumDepth + 1);
    this.#hasImageMediaTypeAt = new Uint8Array(limits.maximumDepth + 1);
    this.#pendingBase64BytesAt = new Float64Array(limits.maximumDepth + 1);
  }

  /** Scans the next chunk; returns the problem once the body is known to be refused. */
  write(chunk: Buffer): JsonScanProblem | undefined {
    if (this.#problem === undefined) {
      this.#scan(chunk);
      this.#chunkOffset += chunk.length;
    }
    return this.#problem;
  }

  /** What was found, once every chunk has been written. */
  finish(): JsonScanOutcome {
    if (this.#problem !== undefined) {
      return this.#problem;
    }
    if (this.#expecting !== expecting.nothingMore) {
      return { kind: "invalid", reason: "the body ends before its JSON does" };
    }
    return {
      kind: "scanned",
      body: {
        members: this.#members,
        closingBraceOffset: this.#closingBraceOffset,
        insignificantBytes: this.#insignificantBytes,
        base64ImageBytes: this.#base64ImageBytes,
        imageCount: Math.max(this.#imageTypeMarks, this.#base64Images),
      },
    };
  }

  #scan(chunk: Buffer): void {
    let index = 0;
    while (index < chunk.length && this.#problem === undefined) {
      if (this.#expecting === expecting.stringContent) {
        index = this.#scanStringContent(chunk, index);
        continue;
      }
      const isConsumed = this.#step(chunk[index] as number, this.#chunkOffset + index);
      if (isConsumed) {
        index += 1;
      }
    }
  }

  /**
   * Reads ordinary string bytes in a tight loop, the bulk of any body,
   * up to the byte that ends them; returns where to carry on.
   */
  #scanStringContent(chunk: Buffer, start: number): number {
    let index = start;
    for (; index < chunk.length; index += 1) {
      const current = chunk[index] as number;
      if (current === byte.quote || current === byte.backslash || current < byte.space) {
        break;
      }
      this.#noteStringByte(current, this.#stringLength + index - start);
    }
    this.#stringLength += index - start;
    if (index === chunk.length) {
      return index;
    }
    const current = chunk[index] as number;
    if (current === byte.quote) {
      this.#endString(this.#chunkOffset + index);
    } else if (current === byte.backslash) {
      this.#noteStringByte(current, this.#stringLength);
      this.#stringLength += 1;
      this.#expecting = expecting.stringEscape;
    } else {
      this.#fail("a string holds an unescaped control character");
    }
    return index + 1;
  }

  #noteStringByte(current: number, position: number): void {
    if (this.#stringPrefixLength < stringPrefixCapacity) {
      this.#stringPrefix[this.#stringPrefixLength] = current;
      this.#stringPrefixLength += 1;
    }
    if (base64Alphabet[current] === 0) {
      this.#lastNonBase64Position = position;
    }
  }

  /** Handles one byte outside a string's ordinary content; false when it must be handled again. */
  #step(current: number, offset: number): boolean {
    switch (this.#expecting) {
      case expecting.value:
        return this.#beginValue(current, offset);
      case expecting.valueOrArrayEnd:
        if (current === byte.closeBracket) {
          this.#closeContainer(false, offset);
          return true;
        }
        return this.#beginValue(current, offset);
      case expecting.keyOrObjectEnd:
        if (current === byte.closeBrace) {
          this.#closeContainer(true, offset);
          return true;
        }
        return this.#beginKey(current, offset);
      case expecting.key:
        return this.#beginKey(current, offset);
      case expecting.colon:
        return this.#expectStructural(
          current,
          byte.colon,
          expecting.value,
          "a key without a colon",
        );
      case expecting.commaOrEnd:
        return this.#afterValue(current, offset);
      case expecting.nothingMore:
        return this.#skipWhitespace(current) || this.#fail("something follows the JSON");
      case expecting.stringEscape:
        return this.#readEscape(current);
      case expecting.unicodeEscapeDigits:
        return this.#readUnicodeDigit(current);
      case expecting.literalLetters:
        return this.#readLiteralLetter(current, offset);
      default:
        return this.#readNumber(current, offset);
    }
  }

  #skipWhitespace(current: number): boolean {
    if (
      current === byte.space ||
      current === byte.lineFeed ||
      current === byte.carriageReturn ||
      current === byte.tab
    ) {
      this.#insignificantBytes += 1;
      return true;
    }
    return false;
  }

  #expectStructural(current: number, wanted: number, next: Expecting, problem: string): boolean {
    if (this.#skipWhitespace(current)) {
      return true;
    }
    if (current !== wanted) {
      return this.#fail(problem);
    }
    this.#expecting = next;
    return true;
  }

  #beginValue(current: number, offset: number): boolean {
    if (this.#skipWhitespace(current)) {
      return true;
    }
    if (this.#depth === 0 && current !== byte.openBrace) {
      return this.#fail("the body is not a JSON object");
    }
    if (this.#depth === 1) {
      this.#member.valueStart = offset;
    }
    if (current === byte.openBrace || current === byte.openBracket) {
      this.#openContainer(current === byte.openBrace);
    } else if (current === byte.quote) {
      this.#beginString(false);
    } else if (current === byte.minus) {
      this.#expecting = expecting.digitAfterMinus;
    } else if (current === byte.zero) {
      this.#expecting = expecting.afterLeadingZero;
    } else if (current > byte.zero && current <= byte.nine) {
      this.#expecting = expecting.integerDigits;
    } else if (literals[current] !== undefined) {
      this.#literal = literals[current];
      this.#literalPosition = 0;
      this.#expecting = expecting.literalLetters;
    } else {
      return this.#fail("a value is not JSON");
    }
    return true;
  }

  #beginKey(current: number, offset: number): boolean {
    if (this.#skipWhitespace(current)) {
      return true;
    }
    if (current !== byte.quote) {
      return this.#fail("an object's key is not a string");
    }
    if (this.#depth === 1) {
      this.#member = { keyStart: offset, keyEnd: 0, valueStart: 0, valueEnd: 0 };
    }
    this.#beginString(true);
    return true;
  }

  #beginString(isKey: boolean): void {
    this.#isKey = isKey;
    this.#stringLength = 0;
    this.#stringPrefixLength = 0;
    this.#lastNonBase64Position = -1;
    this.#expecting = expecting.stringContent;
  }

  #endString(closingQuoteOffset: number): void {
    if (!this.#isKey) {
      this.#noteStringValue();
      this.#completeValue(closingQuoteOffset + 1);
      return;
    }
    this.#keyKindAt[this.#depth] = this.#recogniseKey();
    this.#expecting = expecting.colon;
    if (this.#depth !== 1) {
      return;
    }
    this.#member.keyEnd = closingQuoteOffset + 1;
    if (this.#stringLength > this.#limits.maximumTopLevelKeyBytes) {
      this.#fail("a top-level key is too long");
    }
  }

  #readEscape(current: number): boolean {
    if (!escapeLetters.has(current)) {
      return this.#fail("a string holds an invalid escape");
    }
    this.#noteStringByte(current, this.#stringLength);
    this.#stringLength += 1;
    if (current === 0x75) {
      this.#unicodeDigitsLeft = 4;
      this.#expecting = expecting.unicodeEscapeDigits;
    } else {
      this.#expecting = expecting.stringContent;
    }
    return true;
  }

  #readUnicodeDigit(current: number): boolean {
    if (hexDigits[current] === 0) {
      return this.#fail("a string holds an invalid escape");
    }
    this.#noteStringByte(current, this.#stringLength);
    this.#stringLength += 1;
    this.#unicodeDigitsLeft -= 1;
    if (this.#unicodeDigitsLeft === 0) {
      this.#expecting = expecting.stringContent;
    }
    return true;
  }

  #readLiteralLetter(current: number, offset: number): boolean {
    if (current !== this.#literal[this.#literalPosition]) {
      return this.#fail("a value is not JSON");
    }
    this.#literalPosition += 1;
    if (this.#literalPosition === this.#literal.length) {
      this.#completeValue(offset + 1);
    }
    return true;
  }

  /**
   * A number, by its grammar's states. A number has no closing character,
   * so the byte after it ends it and is then handled again (false).
   */
  #readNumber(current: number, offset: number): boolean {
    const isDigit = current >= byte.zero && current <= byte.nine;
    const isExponentMark = current === byte.lowerE || current === byte.upperE;
    switch (this.#expecting) {
      case expecting.digitAfterMinus:
        return this.#numberMoves(
          isDigit,
          current === byte.zero ? expecting.afterLeadingZero : expecting.integerDigits,
        );
      case expecting.digitAfterPoint:
        return this.#numberMoves(isDigit, expecting.fractionDigits);
      case expecting.digitAfterExponentSign:
        return this.#numberMoves(isDigit, expecting.exponentDigits);
      case expecting.exponentSignOrDigit:
        return this.#numberMoves(
          isDigit || current === byte.plus || current === byte.minus,
          isDigit ? expecting.exponentDigits : expecting.digitAfterExponentSign,
        );
      case expecting.afterLeadingZero:
      case expecting.integerDigits:
        if (isDigit && this.#expecting === expecting.integerDigits) {
          return true;
        }
        if (current === byte.point) {
          this.#expecting = expecting.digitAfterPoint;
          return true;
        }
        return this.#exponentOrEnd(isExponentMark, offset);
      case expecting.fractionDigits:
        return isDigit || this.#exponentOrEnd(isExponentMark, offset);
      default:
        if (isDigit) {
          return true;
        }
        this.#completeValue(offset);
        return false;
    }
  }

  #numberMoves(isAllowed: boolean, next: Expecting): boolean {
    if (!isAllowed) {
      return this.#fail("a number is not JSON");
    }
    this.#expecting = next;
    return true;
  }

  #exponentOrEnd(isExponentMark: boolean, offset: number): boolean {
    if (isExponentMark) {
      this.#expecting = expecting.exponentSignOrDigit;
      return true;
    }
    this.#completeValue(offset);
    return false;
  }

  #afterValue(current: number, offset: number): boolean {
    if (this.#skipWhitespace(current)) {
      return true;
    }
    const isObject = this.#isObjectAt[this.#depth] === 1;
    if (current === byte.comma) {
      this.#expecting = isObject ? expecting.key : expecting.value;
      return true;
    }
    if (current === byte.closeBrace || current === byte.closeBracket) {
      this.#closeContainer(current === byte.closeBrace, offset);
      return true;
    }
    return this.#fail("values are not separated by commas");
  }

  #openContainer(isObject: boolean): void {
    if (this.#depth === this.#limits.maximumDepth) {
      this.#fail("the body nests too deeply");
      return;
    }
    this.#depth += 1;
    this.#isObjectAt[this.#depth] = isObject ? 1 : 0;
    this.#keyKindAt[this.#depth] = keyKinds.otherKey;
    this.#hasImageMediaTypeAt[this.#depth] = 0;
    this.#pendingBase64BytesAt[this.#depth] = 0;
    this.#expecting = isObject ? expecting.keyOrObjectEnd : expecting.valueOrArrayEnd;
  }

  #closeContainer(isObject: boolean, offset: number): void {
    if ((this.#isObjectAt[this.#depth] === 1) !== isObject) {
      this.#fail("a bracket does not match");
      return;
    }
    if (isObject) {
      this.#settleImageSource();
    }
    this.#depth -= 1;
    if (this.#depth === 0) {
      this.#closingBraceOffset = offset;
      this.#expecting = expecting.nothingMore;
      return;
    }
    this.#completeValue(offset + 1);
  }

  #completeValue(endOffset: number): void {
    this.#expecting = expecting.commaOrEnd;
    if (this.#depth !== 1) {
      return;
    }
    this.#member.valueEnd = endOffset;
    this.#members.push(this.#member);
    if (this.#members.length > this.#limits.maximumTopLevelMembers) {
      this.#fail("the body has too many top-level members");
    }
  }

  #recogniseKey(): number {
    for (const [key, kind] of recognisedKeys) {
      if (this.#stringIs(key)) {
        return kind;
      }
    }
    return keyKinds.otherKey;
  }

  /**
   * Notes what a string value says about images: an image part's `type`;
   * a base64 source's `media_type` and `data` (Anthropic's, whose data
   * counts as an image only if its own object's media type is an image's,
   * known when the object closes); or a base64 data URL of an image (the
   * OpenAI formats'). Only exact, unescaped spellings are recognised; any
   * other is counted as text, which errs high.
   */
  #noteStringValue(): void {
    const depth = this.#depth;
    const keyKind = this.#isObjectAt[depth] === 1 ? this.#keyKindAt[depth] : keyKinds.otherKey;
    if (keyKind === keyKinds.type && imageTypes.some((type) => this.#stringIs(type))) {
      this.#imageTypeMarks += 1;
    } else if (keyKind === keyKinds.mediaType && this.#stringStartsWith(imageMediaTypePrefix)) {
      this.#hasImageMediaTypeAt[depth] = 1;
    } else if (
      keyKind === keyKinds.data &&
      this.#lastNonBase64Position === -1 &&
      this.#stringLength >= shortestImageData
    ) {
      this.#pendingBase64BytesAt[depth] =
        (this.#pendingBase64BytesAt[depth] ?? 0) + this.#stringLength;
    } else if (this.#isImageDataUrl()) {
      this.#base64ImageBytes += this.#stringLength;
      this.#base64Images += 1;
    }
  }

  #settleImageSource(): void {
    const depth = this.#depth;
    const pending = this.#pendingBase64BytesAt[depth] ?? 0;
    if (this.#hasImageMediaTypeAt[depth] === 1 && pending > 0) {
      this.#base64ImageBytes += pending;
      this.#base64Images += 1;
    }
  }

  /** `data:image/…;base64,` followed by base64 alone. */
  #isImageDataUrl(): boolean {
    if (!this.#stringStartsWith(imageDataUrlPrefix)) {
      return false;
    }
    const prefix = this.#stringPrefix.subarray(0, this.#stringPrefixLength);
    const markerAt = prefix.indexOf(base64Marker);
    const commaPosition = markerAt + base64Marker.length - 1;
    return markerAt !== -1 && this.#lastNonBase64Position === commaPosition;
  }

  #stringIs(wanted: Buffer): boolean {
    return this.#stringLength === wanted.length && this.#stringStartsWith(wanted);
  }

  #stringStartsWith(wanted: Buffer): boolean {
    return (
      this.#stringPrefixLength >= wanted.length &&
      this.#stringPrefix.compare(wanted, 0, wanted.length, 0, wanted.length) === 0
    );
  }

  #fail(reason: string): false {
    this.#problem ??= { kind: "invalid", reason };
    return false;
  }
}
