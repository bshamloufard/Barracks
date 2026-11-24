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
 * is relayed as received: the scanner found it valid JSON, and found each
 * top-level key one of the agent's, written without an escape, so its bytes
 * are the name any decoder reads. A key inside a member read is decoded by
 * the parse, and the value then compared with the agent's own exactly
 * (`request-body.ts`), so a name written in another case, or one some
 * decoder might fold into another, is simply not one of them.
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

/**
 * Far longer than any member the proxy reads ever is: the agent's settings
 * are a model's name (at most 256 characters), a flag, a count or a few
 * options. With at most nine settings in any of its formats, no body has
 * more than 9 KiB parsed, whatever it holds.
 */
export const maximumReadMemberBytes = 1024;

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
  for (const member of scanned.members) {
    const key = decodeKey(received, member);
    if (membersByKey.has(key)) {
      return { problem: `the body has "${key.slice(0, 64)}" twice` };
    }
    membersByKey.set(key, member);
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
    values.set(key, value);
  }
  return {
    values,
    rebuild: (changes) => rebuildBody(received, scanned, membersByKey, values, changes),
  };
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
