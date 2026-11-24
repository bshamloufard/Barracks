import { Transform, type TransformCallback } from "node:stream";

export const redactedSecretMarker = "[redacted by Barrack]";

/**
 * Replaces every occurrence of `secret` in a byte stream, including one
 * split across chunks, so the owner's key can never reach the sandbox in
 * an answer, whatever a provider echoes back (some quote part of a key in
 * an error; none should quote it whole, but nothing relies on that). The
 * last `secret.length - 1` bytes of each chunk are held back until the next
 * arrives, so a key split between two is still found; the rest passes on
 * at once, which keeps a stream of small events flowing.
 */
export class SecretRedaction extends Transform {
  readonly #secret: Buffer;
  readonly #replacement = Buffer.from(redactedSecretMarker);
  #heldBack: Buffer = Buffer.alloc(0);

  constructor(secret: string) {
    super();
    this.#secret = Buffer.from(secret);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const redacted = this.#redact(Buffer.concat([this.#heldBack, chunk]));
    const keep = Math.min(this.#secret.length - 1, redacted.length);
    this.#heldBack = redacted.subarray(redacted.length - keep);
    const ready = redacted.subarray(0, redacted.length - keep);
    callback(null, ready.length === 0 ? undefined : ready);
  }

  override _flush(callback: TransformCallback): void {
    callback(null, this.#heldBack.length === 0 ? undefined : this.#heldBack);
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
