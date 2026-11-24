/**
 * A token bucket over bytes: up to a second's worth may pass at once, and
 * on average no more than the rate. Bytes are always accepted (they have
 * already been read); what comes back is how long the reader should pause
 * so that the average holds.
 */
export class ByteRateLimit {
  readonly #bytesPerSecond: number;
  readonly #now: () => number;
  #available: number;
  #updatedAt: number;

  constructor(bytesPerSecond: number, now: () => number = Date.now) {
    this.#bytesPerSecond = bytesPerSecond;
    this.#now = now;
    this.#available = bytesPerSecond;
    this.#updatedAt = now();
  }

  /** Counts the bytes, and returns how many milliseconds to wait before reading more. */
  take(byteCount: number): number {
    const now = this.#now();
    const refill = ((now - this.#updatedAt) / 1000) * this.#bytesPerSecond;
    this.#available = Math.min(this.#bytesPerSecond, this.#available + refill) - byteCount;
    this.#updatedAt = now;
    return this.#available >= 0 ? 0 : Math.ceil((-this.#available / this.#bytesPerSecond) * 1000);
  }
}
