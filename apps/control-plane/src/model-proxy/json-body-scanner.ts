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
 * counts by the picture's size rather than by its bytes. Only an image in
 * the place its format sends one (a part of a message, or of a tool's
 * result or output) is counted so; base64 anywhere else is text the model
 * reads.
 *
 * Given the shape of the pinned agent's requests (`AgentRequestShape`, from
 * `@barrack/model-catalogue`), it also refuses, as soon as it is read, what
 * the agent never sends: a top-level member not among the agent's, and an
 * object of a `type` the agent never gives one in that place (an item of
 * the conversation, a part of an item or of a tool result, an image's
 * source, a tool, an Anthropic tool change, a cache marker), or without a
 * `type` where the agent always gives one. So that what it reads is what
 * any JSON decoder reads, a member's name in any of those places must be
 * spelt without an escape and in ASCII, and must not be a name it reads in
 * other letter cases (`Type`, `CONTENT`), which some decoders match
 * regardless of case; a `type` is compared as written, so one spelt with an
 * escape is one the agent never sends. Of those objects only the `type` is
 * checked, not their other members (an image part's file or address, a
 * tool's options), but for the items that carry settings, below. Everywhere
 * else (a tool's schema, a tool call's arguments, the text of a message, a
 * `content` that is not a list) nothing is policed.
 *
 * A conversation item of a kind that carries settings (`settingItems` of
 * the shape: Anthropic's system message, the Responses API's
 * `configuration_update` and `additional_tools`) has its members' names
 * checked too: each must be one the agent gives such an item, and given
 * once. The value of each member that is a setting is kept, as written,
 * each different one once, for the proxy to parse and check
 * (`request-body.ts`): its kind is known only once the item has closed, so
 * the values are kept until then. Such values are bounded, each and in
 * all, so what they cost to parse stays small whatever the body holds.
 */

import type { AgentRequestShape, ObjectType, ProviderApiFormat } from "@barrack/model-catalogue";

export type JsonBodyScannerLimits = {
  /** The deepest nesting accepted; the pinned agent's requests nest about a dozen deep. */
  maximumDepth: number;
  /** The most members the top-level object may have; the agent's requests have about ten. */
  maximumTopLevelMembers: number;
  /** The longest top-level key accepted, in bytes. */
  maximumTopLevelKeyBytes: number;
  /** The longest setting accepted in a conversation item that carries settings, in bytes. */
  maximumItemSettingBytes: number;
  /** The most bytes of such settings in one body, each different one counted once. */
  maximumDistinctItemSettingBytes: number;
};

/**
 * A setting given in a conversation item that carries settings (`reasoning`
 * in a `configuration_update`, say), as written; each different one once.
 */
export type ItemSetting = {
  /** The item's kind, its `type` or `role` (`SettingItemRule.kind`). */
  kind: string;
  member: string;
  text: string;
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
  /** Bytes of base64 image data, where the body's format sends an image. */
  base64ImageBytes: number;
  /** Images the body sends or refers to, however it does. */
  imageCount: number;
  /** The settings given in conversation items that carry them, each different one once. */
  itemSettings: ItemSetting[];
};

export type JsonScanOutcome = { kind: "scanned"; body: ScannedJsonBody } | JsonScanProblem;

/**
 * Why a body is refused: it is not JSON the proxy accepts (`invalid`), or
 * it holds something the agent never sends (`not_relayed`), described by a
 * name of the agent's format (a member's or a type's), never by a value.
 */
export type JsonScanProblem =
  | { kind: "invalid"; reason: string }
  | { kind: "not_relayed"; what: string };

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

/** What follows the first letter of `true`, `false` and `null`, by that letter. */
const literalRests = new Map(
  ["true", "false", "null"].map((literal) => [
    literal.charCodeAt(0),
    Buffer.from(literal.slice(1)),
  ]),
);

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

/**
 * Keys that lead to where an image or a reference to stored input can be;
 * any other key is `otherKey`. `conversation` is the format's own key for
 * its conversation: `messages`, or the Responses API's `input`.
 */
const keyKinds = {
  otherKey: 0,
  type: 1,
  data: 2,
  url: 3,
  imageUrl: 4,
  source: 5,
  content: 6,
  output: 7,
  conversation: 8,
  tools: 9,
  tool: 10,
  definition: 11,
  cacheControl: 12,
  role: 13,
} as const;

/**
 * Where a container lies, among those that can send an image or refer to
 * stored input: the top-level object; its conversation; an item of it (a
 * message, or one of the Responses API's input items); the parts of an
 * item (its `content`, or a Responses tool call's `output`) or of a part
 * (an Anthropic tool result's `content`); one part; an image part's source
 * (Anthropic's `source`, Chat Completions' `image_url` object); the tools,
 * at the top level or in a conversation item, and one tool; the `tool` of
 * an Anthropic part adding or removing a tool, whose `definition` is a
 * tool; and a part's or a tool's `cache_control`. Anything else is
 * `elsewhere`, where nothing is an image and nothing is policed.
 */
const positions = {
  elsewhere: 0,
  top: 1,
  conversation: 2,
  conversationItem: 3,
  parts: 4,
  part: 5,
  imageSource: 6,
  toolList: 7,
  tool: 8,
  toolChange: 9,
  cacheControl: 10,
} as const;

/** What the places where an object's `type` is policed are called, in a refusal. */
const placeNames: ReadonlyMap<number, string> = new Map([
  [positions.conversationItem, "conversation item"],
  [positions.part, "content part"],
  [positions.imageSource, "image source"],
  [positions.tool, "tool"],
  [positions.toolChange, "tool change"],
  [positions.cacheControl, "cache marker"],
]);

/** The types allowed in one place; `allowsNone` for an object without one. */
type AllowedTypes = { allowsNone: boolean; types: Buffer[] };

/**
 * A kind of conversation item that carries settings, as the scanner checks
 * it: the members it may have and those that are settings, each a set of
 * bits standing for names in `CompiledShape.settingItemNames`.
 */
type CompiledSettingItem = {
  kind: string;
  kindKey: number;
  kindBytes: Buffer;
  allowedNames: number;
  settingNames: number;
};

/** The allow-list as the scanner compares it: bytes, by place. */
type CompiledShape = {
  topLevelMembers: Buffer[];
  typesAt: ReadonlyMap<number, AllowedTypes>;
  settingItems: CompiledSettingItem[];
  /** Every name a setting-carrying item may have, of any kind; a name's index is its bit. */
  settingItemNames: Buffer[];
  /** The names that are a setting in some kind of item, whose values are kept. */
  settingNames: number;
};

/** Names are sets of bits in a 32-bit number. */
const mostSettingItemNames = 31;

/** A conversation item's kind when its `type` or `role` names two kinds of setting item. */
const conflictingKinds = -1;

function compileShape(shape: AgentRequestShape): CompiledShape {
  const allowed = (types: readonly ObjectType[]): AllowedTypes => ({
    allowsNone: types.includes(null),
    types: types.flatMap((type) => (type === null ? [] : [Buffer.from(type)])),
  });
  const names = [...new Set(shape.settingItems.flatMap((item) => Object.keys(item.members)))];
  if (names.length > mostSettingItemNames) {
    throw new Error("The conversation items that carry settings have too many members to check.");
  }
  const bitsOf = (wanted: (name: string) => boolean) =>
    names.reduce((bits, name, index) => (wanted(name) ? bits | (1 << index) : bits), 0);
  const settingItems = shape.settingItems.map((item) => ({
    kind: item.kind,
    kindKey: item.kindMember === "role" ? keyKinds.role : keyKinds.type,
    kindBytes: Buffer.from(item.kind),
    allowedNames: bitsOf((name) => Object.hasOwn(item.members, name)),
    settingNames: bitsOf((name) => Array.isArray(item.members[name])),
  }));
  return {
    settingItems,
    settingItemNames: names.map((name) => Buffer.from(name)),
    settingNames: settingItems.reduce((bits, item) => bits | item.settingNames, 0),
    topLevelMembers: Object.keys(shape.members).map((name) => Buffer.from(name)),
    typesAt: new Map([
      [positions.conversationItem, allowed(shape.itemTypes)],
      [positions.part, allowed(shape.partTypes)],
      [positions.imageSource, allowed(shape.imageSourceTypes)],
      [positions.tool, allowed(shape.toolTypes)],
      [positions.toolChange, allowed(shape.toolChangeTypes)],
      [positions.cacheControl, allowed(shape.cacheControlTypes)],
    ]),
  };
}

/** What an object's `type` says, as far as images go; a type given twice says nothing to trust. */
const typeKinds = { unstated: 0, imagePart: 1, base64Source: 2, other: 3, givenTwice: 4 } as const;

/**
 * The `type` of an image part in each relayed format: Anthropic's `image`
 * (whose `source` is `{type: "base64", data}`), the Responses API's
 * `input_image` (whose `image_url` is a data URL) and Chat Completions'
 * `image_url` (whose `image_url.url` is).
 * https://docs.anthropic.com/en/docs/build-with-claude/vision
 * https://platform.openai.com/docs/guides/images-vision
 */
const imagePartTypes: Readonly<Record<ProviderApiFormat, Buffer>> = {
  anthropic_messages: Buffer.from("image"),
  openai_responses: Buffer.from("input_image"),
  openai_chat_completions: Buffer.from("image_url"),
};
const anyImagePartType = Object.values(imagePartTypes);
const base64SourceType = Buffer.from("base64");

const imageDataUrlPrefix = Buffer.from("data:image/");
const base64Marker = Buffer.from(";base64,");

function lowerCase(letter: number): number {
  return letter >= 0x41 && letter <= 0x5a ? letter + 0x20 : letter;
}

function recognisedKeysFor(format: ProviderApiFormat): ReadonlyArray<[Buffer, number]> {
  return [
    [Buffer.from("type"), keyKinds.type],
    [Buffer.from("data"), keyKinds.data],
    [Buffer.from("url"), keyKinds.url],
    [Buffer.from("image_url"), keyKinds.imageUrl],
    [Buffer.from("source"), keyKinds.source],
    [Buffer.from("content"), keyKinds.content],
    [Buffer.from("output"), keyKinds.output],
    [Buffer.from(format === "openai_responses" ? "input" : "messages"), keyKinds.conversation],
    [Buffer.from("tools"), keyKinds.tools],
    [Buffer.from("tool"), keyKinds.tool],
    [Buffer.from("definition"), keyKinds.definition],
    [Buffer.from("cache_control"), keyKinds.cacheControl],
    [Buffer.from("role"), keyKinds.role],
  ];
}

/** Shorter base64 than this is no picture worth estimating apart. */
const shortestImageData = 64;

export class JsonBodyScanner {
  readonly #limits: JsonBodyScannerLimits;
  readonly #format: ProviderApiFormat;
  readonly #shape: CompiledShape | undefined;
  readonly #recognisedKeys: ReadonlyArray<[Buffer, number]>;
  #expecting: Expecting = expecting.value;
  #problem: JsonScanProblem | undefined;
  /** The offset of the first byte of the chunk being scanned. */
  #chunkOffset = 0;
  #depth = 0;
  readonly #isObjectAt: Uint8Array;
  readonly #keyKindAt: Uint8Array;
  readonly #positionAt: Uint8Array;
  readonly #typeAt: Uint8Array;
  /** Image data within the object at each depth, counted once its parts' types confirm it. */
  readonly #pendingBase64BytesAt: Float64Array;
  readonly #pendingImagesAt: Float64Array;
  // The string being read.
  #isKey = false;
  #stringLength = 0;
  #stringHasEscape = false;
  #stringHasNonAscii = false;
  #lastNonBase64Position = -1;
  readonly #stringPrefix = Buffer.alloc(stringPrefixCapacity);
  #stringPrefixLength = 0;
  #unicodeDigitsLeft = 0;
  // The literal being read.
  #literal: Buffer = Buffer.alloc(0);
  #literalPosition = 0;
  // What the scan found.
  readonly #members: TopLevelMember[] = [];
  #member: TopLevelMember = { keyStart: 0, keyEnd: 0, valueStart: 0, valueEnd: 0 };
  #closingBraceOffset = 0;
  #insignificantBytes = 0;
  #base64ImageBytes = 0;
  #base64Images = 0;
  #imageTypeMarks = 0;
  // The conversation item open now, as one that may carry settings: items
  // never nest, so one at a time. Its kind is the index of the setting item
  // it names plus one, 0 for none yet, or `conflictingKinds`.
  #itemKind = 0;
  #itemNamesSeen = 0;
  #itemHasOtherName = false;
  #itemHasNameTwice = false;
  #itemSettings: Array<{ name: number; bytes: Buffer | undefined }> = [];
  // The setting being kept as it is read: its name's index, and where it began.
  #nextSettingName = -1;
  #keptSettingName = -1;
  #keptSettingDepth = 0;
  #keptSettingStart = 0;
  #keptSettingParts: Buffer[] = [];
  #keptSettingLength = 0;
  /** The chunk being scanned. */
  #chunk: Buffer = Buffer.alloc(0);
  // Every different setting kept, by kind, name and text, and their bytes in all.
  readonly #distinctItemSettings = new Map<string, ItemSetting>();
  #distinctItemSettingBytes = 0;

  /**
   * `format` is the relayed format the body is in, which says where it may
   * send images; `shape`, what the agent's requests in it may hold. Without
   * a shape, which only tests of the grammar and of images leave out,
   * nothing is policed.
   */
  constructor(
    limits: JsonBodyScannerLimits,
    format: ProviderApiFormat,
    shape: AgentRequestShape | undefined,
  ) {
    this.#limits = limits;
    this.#format = format;
    this.#shape = shape === undefined ? undefined : compileShape(shape);
    this.#recognisedKeys = recognisedKeysFor(format);
    this.#isObjectAt = new Uint8Array(limits.maximumDepth + 1);
    this.#keyKindAt = new Uint8Array(limits.maximumDepth + 1);
    this.#positionAt = new Uint8Array(limits.maximumDepth + 1);
    this.#typeAt = new Uint8Array(limits.maximumDepth + 1);
    this.#pendingBase64BytesAt = new Float64Array(limits.maximumDepth + 1);
    this.#pendingImagesAt = new Float64Array(limits.maximumDepth + 1);
  }

  /** Scans the next chunk; returns the problem once the body is known to be refused. */
  write(chunk: Buffer): JsonScanProblem | undefined {
    if (this.#problem === undefined) {
      this.#chunk = chunk;
      this.#scan(chunk);
      this.#keepSettingUpTo(chunk.length);
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
        itemSettings: [...this.#distinctItemSettings.values()],
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
      this.#stringHasEscape = true;
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
      this.#stringHasNonAscii ||= current >= 0x80;
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
    if (this.#nextSettingName !== -1) {
      this.#beginKeepingSetting(offset);
    }
    if (current !== byte.quote && this.#isPolicedTypeKey()) {
      return this.#refuse(`a ${this.#placeName()} whose \`type\` is not text`);
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
    } else if (literalRests.has(current)) {
      this.#literal = literalRests.get(current) ?? Buffer.alloc(0);
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
    this.#stringHasEscape = false;
    this.#stringHasNonAscii = false;
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
    if (this.#depth === 1) {
      this.#member.keyEnd = closingQuoteOffset + 1;
      if (this.#stringLength > this.#limits.maximumTopLevelKeyBytes) {
        this.#fail("a top-level key is too long");
        return;
      }
    }
    this.#checkPolicedKey();
    if (this.#positionAt[this.#depth] === positions.conversationItem) {
      this.#noteItemMemberName();
    }
  }

  /**
   * A member's name in a conversation item, as an item that may carry
   * settings: which of the names such items have it is, if any, and whether
   * it was given before; a setting's value is kept as it is read.
   */
  #noteItemMemberName(): void {
    const names = this.#shape?.settingItemNames ?? [];
    const index = names.findIndex((name) => this.#stringIs(name));
    if (index === -1) {
      this.#itemHasOtherName = true;
      return;
    }
    const bit = 1 << index;
    if ((this.#itemNamesSeen & bit) !== 0) {
      this.#itemHasNameTwice = true;
      return;
    }
    this.#itemNamesSeen |= bit;
    if (((this.#shape?.settingNames ?? 0) & bit) !== 0) {
      this.#nextSettingName = index;
    }
  }

  #beginKeepingSetting(offset: number): void {
    this.#keptSettingName = this.#nextSettingName;
    this.#nextSettingName = -1;
    this.#keptSettingDepth = this.#depth;
    this.#keptSettingStart = offset;
    this.#keptSettingParts = [];
    this.#keptSettingLength = 0;
  }

  /** Keeps the setting being read up to `end` in this chunk, while it is short enough to keep. */
  #keepSettingUpTo(end: number): void {
    if (this.#keptSettingName === -1) {
      return;
    }
    const maximum = this.#limits.maximumItemSettingBytes;
    if (this.#keptSettingLength <= maximum) {
      const part = this.#chunk.subarray(
        Math.max(this.#keptSettingStart - this.#chunkOffset, 0),
        end,
      );
      this.#keptSettingLength += part.length;
      this.#keptSettingParts =
        this.#keptSettingLength <= maximum ? [...this.#keptSettingParts, part] : [];
    }
  }

  #finishKeepingSetting(endOffset: number): void {
    this.#keepSettingUpTo(endOffset - this.#chunkOffset);
    const parts = this.#keptSettingParts;
    this.#itemSettings.push({
      name: this.#keptSettingName,
      bytes:
        this.#keptSettingLength > this.#limits.maximumItemSettingBytes
          ? undefined
          : parts.length === 1
            ? parts[0]
            : Buffer.concat(parts),
    });
    this.#keptSettingName = -1;
    this.#keptSettingParts = [];
  }

  /** The conversation item's `type` or `role`, which may name a kind of item that carries settings. */
  #noteItemKind(keyKind: number): void {
    const items = this.#shape?.settingItems ?? [];
    if (!items.some((item) => item.kindKey === keyKind)) {
      return;
    }
    // A type is compared as written; a role is not otherwise policed, so it must be written plainly.
    if (keyKind === keyKinds.role && (this.#stringHasEscape || this.#stringHasNonAscii)) {
      this.#refuse("a conversation item whose `role` is written with an escape or outside ASCII");
      return;
    }
    const index = items.findIndex(
      (item) => item.kindKey === keyKind && this.#stringIs(item.kindBytes),
    );
    if (index !== -1) {
      this.#itemKind =
        this.#itemKind === 0 || this.#itemKind === index + 1 ? index + 1 : conflictingKinds;
    }
  }

  /**
   * As a conversation item closes, if it is of a kind that carries settings:
   * its members must be those the agent gives such an item, each once, and
   * each setting's value is kept, each different one once, within bounds.
   */
  #settleItem(): void {
    const shape = this.#shape;
    if (shape === undefined || this.#itemKind === 0) {
      return;
    }
    const item = shape.settingItems[this.#itemKind - 1];
    if (item === undefined) {
      this.#refuse("a conversation item of two kinds at once");
      return;
    }
    const where = `a \`${item.kind}\` conversation item`;
    if (this.#itemHasOtherName || (this.#itemNamesSeen & ~item.allowedNames) !== 0) {
      this.#refuse(`a member the agent never sends in ${where}`);
      return;
    }
    if (this.#itemHasNameTwice) {
      this.#refuse(`a member given twice in ${where}`);
      return;
    }
    for (const { name, bytes } of this.#itemSettings) {
      const member = shape.settingItemNames[name]?.toString("latin1") ?? "";
      if ((item.settingNames & (1 << name)) === 0) {
        continue;
      }
      if (bytes === undefined) {
        this.#refuse(`the value given for \`${member}\` in ${where}, which is too long`);
        return;
      }
      const text = bytes.toString("utf8");
      const key = `${item.kind}\u0000${member}\u0000${text}`;
      if (!this.#distinctItemSettings.has(key)) {
        this.#distinctItemSettingBytes += bytes.length;
        if (this.#distinctItemSettingBytes > this.#limits.maximumDistinctItemSettingBytes) {
          this.#refuse("so many different settings in conversation items");
          return;
        }
        this.#distinctItemSettings.set(key, { kind: item.kind, member, text });
      }
    }
  }

  /**
   * In a place the allow-list polices, a member's name must be one any
   * decoder reads as the proxy does: written without an escape, in ASCII,
   * and not a name the proxy reads written in other letters' cases; at the
   * top level, it must be one of the agent's own members.
   */
  #checkPolicedKey(): void {
    const position = this.#positionAt[this.#depth];
    if (this.#shape === undefined || position === positions.elsewhere) {
      return;
    }
    if (this.#stringHasEscape || this.#stringHasNonAscii) {
      this.#refuse("a member whose name is written with an escape or outside ASCII");
      return;
    }
    if (
      this.#keyKindAt[this.#depth] === keyKinds.otherKey &&
      this.#isRecognisedKeyInAnotherCase()
    ) {
      this.#refuse(`the member ${this.#quotedString()}, in that case`);
      return;
    }
    if (
      position === positions.top &&
      !this.#shape.topLevelMembers.some((name) => this.#stringIs(name))
    ) {
      this.#refuse(`the member ${this.#quotedString()}`);
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
    const position = this.#positionInside(isObject);
    this.#depth += 1;
    this.#isObjectAt[this.#depth] = isObject ? 1 : 0;
    this.#keyKindAt[this.#depth] = keyKinds.otherKey;
    this.#positionAt[this.#depth] = position;
    this.#typeAt[this.#depth] = typeKinds.unstated;
    this.#pendingBase64BytesAt[this.#depth] = 0;
    this.#pendingImagesAt[this.#depth] = 0;
    this.#expecting = isObject ? expecting.keyOrObjectEnd : expecting.valueOrArrayEnd;
    if (position === positions.conversationItem) {
      this.#itemKind = 0;
      this.#itemNamesSeen = 0;
      this.#itemHasOtherName = false;
      this.#itemHasNameTwice = false;
      this.#itemSettings.length = 0;
    }
  }

  /** Where a container opened now lies, from where its parent lies and the key it is under. */
  #positionInside(isObject: boolean): number {
    const parentDepth = this.#depth;
    if (parentDepth === 0) {
      return positions.top;
    }
    const parent = this.#positionAt[parentDepth];
    const key =
      this.#isObjectAt[parentDepth] === 1 ? this.#keyKindAt[parentDepth] : keyKinds.otherKey;
    if (isObject) {
      switch (parent) {
        case positions.conversation:
          return positions.conversationItem;
        case positions.parts:
          return positions.part;
        case positions.toolList:
          return positions.tool;
        case positions.part:
          return key === this.#imageSourceKey()
            ? positions.imageSource
            : key === keyKinds.tool
              ? positions.toolChange
              : key === keyKinds.cacheControl
                ? positions.cacheControl
                : positions.elsewhere;
        case positions.tool:
          return key === keyKinds.cacheControl ? positions.cacheControl : positions.elsewhere;
        case positions.toolChange:
          return key === keyKinds.definition ? positions.tool : positions.elsewhere;
        default:
          return positions.elsewhere;
      }
    }
    const isUnderContent = key === keyKinds.content;
    if (parent === positions.top) {
      return key === keyKinds.conversation
        ? positions.conversation
        : key === keyKinds.tools
          ? positions.toolList
          : positions.elsewhere;
    }
    if (parent === positions.conversationItem && (isUnderContent || key === keyKinds.output)) {
      return positions.parts;
    }
    // Tools declared mid-conversation (the Responses API's `additional_tools` items).
    if (parent === positions.conversationItem && key === keyKinds.tools) {
      return positions.toolList;
    }
    return parent === positions.part && isUnderContent ? positions.parts : positions.elsewhere;
  }

  /**
   * The key of an image part whose value is an object holding the image:
   * Anthropic's `source`, Chat Completions' `image_url`. The Responses API
   * has none: its `image_url` is the data URL itself.
   */
  #imageSourceKey(): number | undefined {
    switch (this.#format) {
      case "anthropic_messages":
        return keyKinds.source;
      case "openai_chat_completions":
        return keyKinds.imageUrl;
      case "openai_responses":
        return undefined;
    }
  }

  #closeContainer(isObject: boolean, offset: number): void {
    if ((this.#isObjectAt[this.#depth] === 1) !== isObject) {
      this.#fail("a bracket does not match");
      return;
    }
    if (isObject && this.#typeAt[this.#depth] === typeKinds.unstated) {
      const allowed = this.#allowedTypesHere();
      if (allowed !== undefined && !allowed.allowsNone) {
        this.#refuse(`a ${this.#placeName()} without a \`type\``);
        return;
      }
    }
    if (isObject) {
      this.#settleImages();
    }
    if (isObject && this.#positionAt[this.#depth] === positions.conversationItem) {
      this.#settleItem();
      if (this.#problem !== undefined) {
        return;
      }
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
    if (this.#keptSettingName !== -1 && this.#depth === this.#keptSettingDepth) {
      this.#finishKeepingSetting(endOffset);
    }
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
    for (const [key, kind] of this.#recognisedKeys) {
      if (this.#stringIs(key)) {
        return kind;
      }
    }
    return keyKinds.otherKey;
  }

  /**
   * Notes what a string value says about images and referenced input: a
   * `type` (see `#noteType`), or image data where the format sends it,
   * held until the objects around it close and their types confirm it is
   * an image. Only exact, unescaped spellings are recognised; any other is
   * counted as text, which errs high.
   */
  #noteStringValue(): void {
    const depth = this.#depth;
    const keyKind = this.#isObjectAt[depth] === 1 ? this.#keyKindAt[depth] : keyKinds.otherKey;
    const position = this.#positionAt[depth] ?? positions.elsewhere;
    if (
      position === positions.conversationItem &&
      (keyKind === keyKinds.type || keyKind === keyKinds.role)
    ) {
      this.#noteItemKind(keyKind);
    }
    if (keyKind === keyKinds.type) {
      this.#noteType(depth, position);
    } else if (this.#isImageData(keyKind, position)) {
      this.#pendingBase64BytesAt[depth] =
        (this.#pendingBase64BytesAt[depth] ?? 0) + this.#stringLength;
      this.#pendingImagesAt[depth] = (this.#pendingImagesAt[depth] ?? 0) + 1;
    }
  }

  /** Whether the string just read is image data in the place its format sends it. */
  #isImageData(keyKind: number | undefined, position: number): boolean {
    switch (this.#format) {
      case "anthropic_messages":
        return (
          position === positions.imageSource &&
          keyKind === keyKinds.data &&
          this.#lastNonBase64Position === -1 &&
          this.#stringLength >= shortestImageData
        );
      case "openai_chat_completions":
        return (
          position === positions.imageSource && keyKind === keyKinds.url && this.#isImageDataUrl()
        );
      case "openai_responses":
        return (
          position === positions.part && keyKind === keyKinds.imageUrl && this.#isImageDataUrl()
        );
    }
  }

  /**
   * An object's `type`: an image part's anywhere counts as an image sent
   * (by data or by reference), which errs high; in a place the allow-list
   * polices, it must be one the agent gives an object there; and the
   * object's own type is kept, or marked as given twice.
   */
  #noteType(depth: number, position: number): void {
    if (anyImagePartType.some((type) => this.#stringIs(type))) {
      this.#imageTypeMarks += 1;
    }
    const allowed = this.#shape?.typesAt.get(position);
    if (allowed !== undefined && !allowed.types.some((type) => this.#stringIs(type))) {
      this.#refuse(`the ${placeNames.get(position)} type ${this.#quotedString()}`);
      return;
    }
    this.#typeAt[depth] =
      this.#typeAt[depth] !== typeKinds.unstated
        ? typeKinds.givenTwice
        : this.#stringIs(imagePartTypes[this.#format])
          ? typeKinds.imagePart
          : this.#stringIs(base64SourceType)
            ? typeKinds.base64Source
            : typeKinds.other;
  }

  /**
   * As an object closes, the image data within it is passed on: from an
   * image source to its part (Anthropic's only if its type is `base64`),
   * and from a part to the body's count only if the part is an image.
   */
  #settleImages(): void {
    const depth = this.#depth;
    const bytes = this.#pendingBase64BytesAt[depth] ?? 0;
    const images = this.#pendingImagesAt[depth] ?? 0;
    if (images === 0) {
      return;
    }
    const type = this.#typeAt[depth];
    if (this.#positionAt[depth] === positions.imageSource) {
      const isBase64 = this.#format !== "anthropic_messages" || type === typeKinds.base64Source;
      if (isBase64) {
        this.#pendingBase64BytesAt[depth - 1] =
          (this.#pendingBase64BytesAt[depth - 1] ?? 0) + bytes;
        this.#pendingImagesAt[depth - 1] = (this.#pendingImagesAt[depth - 1] ?? 0) + images;
      }
    } else if (this.#positionAt[depth] === positions.part && type === typeKinds.imagePart) {
      this.#base64ImageBytes += bytes;
      this.#base64Images += images;
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

  /** Whether the value about to be read is an object's `type` in a place the allow-list polices. */
  #isPolicedTypeKey(): boolean {
    const depth = this.#depth;
    return (
      this.#isObjectAt[depth] === 1 &&
      this.#keyKindAt[depth] === keyKinds.type &&
      this.#allowedTypesHere() !== undefined
    );
  }

  /** The types allowed of the object open now, if its place is policed. */
  #allowedTypesHere(): AllowedTypes | undefined {
    return this.#shape?.typesAt.get(this.#positionAt[this.#depth] ?? positions.elsewhere);
  }

  #placeName(): string {
    return placeNames.get(this.#positionAt[this.#depth] ?? positions.elsewhere) ?? "member";
  }

  /**
   * Whether the key just read is one the scanner reads, or in a conversation
   * item one that items carrying settings have, written in other letters' cases.
   */
  #isRecognisedKeyInAnotherCase(): boolean {
    const isInAnotherCase = (key: Buffer) =>
      this.#stringLength === key.length &&
      this.#stringPrefixLength >= key.length &&
      key.every((letter, index) => lowerCase(this.#stringPrefix[index] ?? 0) === letter);
    return (
      this.#recognisedKeys.some(([key]) => isInAnotherCase(key)) ||
      (this.#positionAt[this.#depth] === positions.conversationItem &&
        (this.#shape?.settingItemNames ?? []).some(
          (key) => !this.#stringIs(key) && isInAnotherCase(key),
        ))
    );
  }

  /**
   * The string just read, quoted, for a refusal: a name of the format's
   * when it is one (short and in plain ASCII), otherwise only that it is
   * not one, so no value of the body's reaches a refusal or the log.
   */
  #quotedString(): string {
    const text = this.#stringPrefix.toString("latin1", 0, this.#stringPrefixLength);
    const isName =
      this.#stringLength === this.#stringPrefixLength && /^[A-Za-z0-9_.-]{1,48}$/.test(text);
    return isName ? `\`${text}\`` : "that is not a plain name";
  }

  #refuse(what: string): false {
    this.#problem ??= { kind: "not_relayed", what };
    return false;
  }

  #fail(reason: string): false {
    this.#problem ??= { kind: "invalid", reason };
    return false;
  }
}
