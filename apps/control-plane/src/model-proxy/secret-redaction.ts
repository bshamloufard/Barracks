import { Transform, type TransformCallback } from "node:stream";

export const redactedSecretMarker = "[redacted by Barrack]";

/**
 * Replaces every occurrence of `secret` in a byte stream, including one
 * split across chunks, so the owner's key can never reach the sandbox in
 * an answer, whatever a provider echoes back (some quote part of a key in
 * an error; none should quote it whole, but nothing relies on that). Only
 * the end of each chunk that could be the start of the secret is held back
 * until the next arrives, so a key split between two is still found, and
 * everything else passes on at once: a ChatGPT plan's access token is a
 * couple of kilobytes, and holding back that much would hold each streamed
 * event until the next ones pushed it out.
 */
export class SecretRedaction extends Transform {
  readonly #secret: Buffer;
  /** For each length of the secret's start, the longest proper border of it (Knuth, Morris and Pratt's table). */
  readonly #borders: Uint32Array;
  readonly #replacement = Buffer.from(redactedSecretMarker);
  #heldBack: Buffer = Buffer.alloc(0);

  constructor(secret: string) {
    super();
    this.#secret = Buffer.from(secret);
    this.#borders = computeBorders(this.#secret);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const redacted = this.#redact(Buffer.concat([this.#heldBack, chunk]));
    const keep = this.#measureSecretStartAtEnd(redacted);
    this.#heldBack = redacted.subarray(redacted.length - keep);
    const ready = redacted.subarray(0, redacted.length - keep);
    callback(null, ready.length === 0 ? undefined : ready);
  }

  override _flush(callback: TransformCallback): void {
    callback(null, this.#heldBack.length === 0 ? undefined : this.#heldBack);
  }

  /**
   * How many of the last bytes could be the secret's first ones: the
   * longest end of `bytes` that is a start of the secret, found by running
   * the secret's matcher over the last `secret.length - 1` bytes, in time
   * proportional to them.
   */
  #measureSecretStartAtEnd(bytes: Buffer): number {
    const tailStart = Math.max(0, bytes.length - (this.#secret.length - 1));
    let matched = 0;
    for (let index = tailStart; index < bytes.length; index += 1) {
      while (matched > 0 && bytes[index] !== this.#secret[matched]) {
        matched = this.#borders[matched - 1] ?? 0;
      }
      if (bytes[index] === this.#secret[matched]) {
        matched += 1;
      }
    }
    return matched;
  }

  #redact(bytes: Buffer): Buffer {
    const parts: Buffer[] = [];
    let start = 0;
    for (
      let found = bytes.indexOf(this.#secret, start);
      found !== -1;
      found = bytes.indexOf(this.#secret, start)
    ) {
      parts.push(bytes.subarray(start, found), this.#replacement);
      start = found + this.#secret.length;
    }
    if (parts.length === 0) {
      return bytes;
    }
    parts.push(bytes.subarray(start));
    return Buffer.concat(parts);
  }
}

function computeBorders(secret: Buffer): Uint32Array {
  const borders = new Uint32Array(secret.length);
  let border = 0;
  for (let index = 1; index < secret.length; index += 1) {
    while (border > 0 && secret[index] !== secret[border]) {
      border = borders[border - 1] ?? 0;
    }
    if (secret[index] === secret[border]) {
      border += 1;
    }
    borders[index] = border;
  }
  return borders;
}
