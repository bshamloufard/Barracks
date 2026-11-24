/**
 * Agent event frames waiting for the control plane to come back, in the order
 * they happened. It is bounded so that a long outage cannot exhaust the
 * sandbox's memory, and it refuses a frame rather than dropping an older one:
 * thread events are history, and a silent gap would be worse than a loud
 * failure.
 */
export class AgentEventBacklog {
  readonly #maximumTotalLength: number;
  #frames: string[] = [];
  #totalLength = 0;

  /** `maximumTotalLength` is in characters of serialized frames, the memory that matters. */
  constructor(maximumTotalLength: number) {
    this.#maximumTotalLength = maximumTotalLength;
  }

  /** Returns false, and keeps nothing, when the frame does not fit. */
  add(frame: string): boolean {
    if (this.#totalLength + frame.length > this.#maximumTotalLength) {
      return false;
    }
    this.#frames.push(frame);
    this.#totalLength += frame.length;
    return true;
  }

  /** Empties the backlog and returns its frames, oldest first. */
  takeAll(): string[] {
    const frames = this.#frames;
    this.#frames = [];
    this.#totalLength = 0;
    return frames;
  }

  get frameCount(): number {
    return this.#frames.length;
  }
}
