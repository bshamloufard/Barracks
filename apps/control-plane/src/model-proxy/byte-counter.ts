import { Transform, type TransformCallback } from "node:stream";

export class ByteLimitExceededError extends Error {
  constructor(limit: number) {
    super(`More than ${limit} bytes`);
    this.name = "ByteLimitExceededError";
  }
}

/**
 * Passes bytes through, counting them, handing each chunk to `observe`, and
 * failing the stream once more than `limit` have passed, which ends the
 * pipeline it is in.
 */
export class ByteCounter extends Transform {
  readonly #limit: number;
  readonly #observe: (chunk: Buffer) => void;
  #count = 0;

  constructor(limit: number, observe: (chunk: Buffer) => void = () => {}) {
    super();
    this.#limit = limit;
    this.#observe = observe;
  }

  get count(): number {
    return this.#count;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#count += chunk.length;
    if (this.#count > this.#limit) {
      callback(new ByteLimitExceededError(this.#limit));
      return;
    }
    this.#observe(chunk);
    callback(null, chunk);
  }
}
