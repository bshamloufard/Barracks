import { isUtf8 } from "node:buffer";
import type { ScannedJsonBody, TopLevelMember } from "./json-body-scanner.js";

/**
 * The top-level members of a scanned body that the proxy reads, parsed,
 * and the bytes it relays: the body as received, except that each member
 * it read is written out again from what it parsed, so the provider is
 * sent exactly what was checked (a member that holds the same key twice,
 * say, cannot mean one thing here and another to the provider), and that a
 * member the proxy changes or adds is spliced in. A top-level key that
 * appears twice is refused outright, for the same reason. Everything else
 * is relayed as received: the scanner found it valid JSON.
 *
 * Some providers' JSON decoders match a field's name regardless of case,
 * folding Unicode as they do (Go's `encoding/json` reads `ſtream`, with a
 * long s, as `stream`), so a key the proxy did not read could be read there
 * as one it did. So a body is also refused when two of its top-level keys
 * are the same once folded (`foldKey`), when a top-level key folds to one
 * the proxy reads without being that key, and when any key inside a member
 * the proxy reads is not already in its folded form. The agent's own keys
 * are all lowercase ASCII.
 *
 * Only members the proxy reads are parsed, each at most
 * `maximumReadMemberBytes`, so what this costs is bounded whatever the
 * body holds.
 */
export type ReadMembers = {
  /** The members read, by key, as parsed. */
  values: ReadonlyMap<string, unknown>;
  /** Builds the bytes to relay, with `changes` (by key) written in place of, or after, the rest. */
  rebuild(changes: ReadonlyMap<string, unknown>): Buffer;
};

/** Far longer than any member the proxy reads (a model, a flag, a few options) ever is. */
export const maximumReadMemberBytes = 64 * 1024;

export function readTopLevelMembers(
  received: Buffer,
  scanned: ScannedJsonBody,
  readKeys: ReadonlySet<string>,
): ReadMembers | { problem: string } {
  // JSON is UTF-8 (RFC 8259); bytes that are not cannot mean one thing to every parser.
  if (!isUtf8(received)) {
    return { problem: "the body is not UTF-8" };
  }
  const membersByKey = new Map<string, TopLevelMember>();
  const keysByFoldedKey = new Map<string, string>();
  const foldedReadKeys = new Set([...readKeys].map(foldKey));
  for (const member of scanned.members) {
    const key = decodeKey(received, member);
    if (membersByKey.has(key)) {
      return { problem: `the body has "${key.slice(0, 64)}" twice` };
    }
    const folded = foldKey(key);
    if (keysByFoldedKey.has(folded) || (foldedReadKeys.has(folded) && !readKeys.has(key))) {
      return {
        problem: `the body spells "${folded.slice(0, 64)}" in a way the proxy does not read`,
      };
    }
    membersByKey.set(key, member);
    keysByFoldedKey.set(folded, key);
  }
  const values = new Map<string, unknown>();
  for (const key of readKeys) {
    const member = membersByKey.get(key);
    if (member === undefined) {
      continue;
    }
    if (member.valueEnd - member.valueStart > maximumReadMemberBytes) {
      return { problem: `the body's "${key}" is too long` };
    }
    const value: unknown = JSON.parse(
      received.toString("utf8", member.valueStart, member.valueEnd),
    );
    if (!areKeysFolded(value)) {
      return { problem: `the body's "${key}" spells a key in a way the proxy does not read` };
    }
    values.set(key, value);
  }
  return {
    values,
    rebuild: (changes) => rebuildBody(received, scanned, membersByKey, values, changes),
  };
}

/**
 * A key as a decoder that ignores case might match it: compatibility
 * normalised (a full-width `ｍ` or a long `ſ` becomes `m` or `s`) and case
 * folded (`K`, the Kelvin sign, becomes `k`; `ß` becomes `ss`). Plain
 * ASCII, which every key of the agent's is, takes the short way.
 */
function foldKey(key: string): string {
  const isAscii = Buffer.byteLength(key) === key.length;
  if (isAscii) {
    return key.toLowerCase();
  }
  return key.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

/** Whether every key of every object within `value` is in its folded form. */
function areKeysFolded(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every(areKeysFolded);
  }
  if (typeof value !== "object" || value === null) {
    return true;
  }
  return Object.entries(value).every(
    ([key, nested]) => foldKey(key) === key && areKeysFolded(nested),
  );
}

/** A key with no escape is its own bytes; one with an escape is decoded as JSON would. */
function decodeKey(received: Buffer, member: TopLevelMember): string {
  const quoted = received.subarray(member.keyStart, member.keyEnd);
  return quoted.includes(0x5c)
    ? (JSON.parse(quoted.toString("utf8")) as string)
    : quoted.toString("utf8", 1, quoted.length - 1);
}

/**
 * The body with every member read written out again where that differs
 * from what was received, `changes` in place of the members they name,
 * and `changes` naming no member added at the end. With nothing to
 * replace, the received bytes themselves, not a copy.
 */
function rebuildBody(
  received: Buffer,
  scanned: ScannedJsonBody,
  membersByKey: ReadonlyMap<string, TopLevelMember>,
  values: ReadonlyMap<string, unknown>,
  changes: ReadonlyMap<string, unknown>,
): Buffer {
  const replacements: Array<{ member: TopLevelMember; value: Buffer }> = [];
  for (const [key, value] of new Map([...values, ...changes])) {
    const member = membersByKey.get(key);
    if (member === undefined) {
      continue;
    }
    const written = Buffer.from(JSON.stringify(value));
    if (!written.equals(received.subarray(member.valueStart, member.valueEnd))) {
      replacements.push({ member, value: written });
    }
  }
  const additions = [...changes]
    .filter(([key]) => !membersByKey.has(key))
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
    .map((member, index) => (index === 0 && membersByKey.size === 0 ? member : `,${member}`));
  if (replacements.length === 0 && additions.length === 0) {
    return received;
  }
  replacements.sort((first, second) => first.member.valueStart - second.member.valueStart);
  const parts: Buffer[] = [];
  let copiedUpTo = 0;
  for (const { member, value } of replacements) {
    parts.push(received.subarray(copiedUpTo, member.valueStart), value);
    copiedUpTo = member.valueEnd;
  }
  parts.push(received.subarray(copiedUpTo, scanned.closingBraceOffset));
  parts.push(Buffer.from(additions.join("")), received.subarray(scanned.closingBraceOffset));
  return Buffer.concat(parts);
}
