/** One agent event's frame, ready to send, and its number among this supervisor's events. */
export type NumberedFrame = { eventNumber: number; frame: string };

/**
 * Every agent event this supervisor has produced and the control plane has
 * not yet confirmed it recorded, oldest first: events not sent yet (while
 * the control plane is unreachable, say) and events sent but not yet
 * acknowledged, which a connection that dies may have lost. Each one stays
 * until the control plane says it is durably recorded, and everything here
 * is sent again, in order, on every new connection.
 *
 * It is bounded so that a long outage cannot exhaust the sandbox's memory,
 * and it refuses a frame rather than dropping an older one: thread events
 * are history, and a silent gap would be worse than a loud failure.
 */
export class UnconfirmedAgentEvents {
  readonly #maximumTotalLength: number;
  #frames: NumberedFrame[] = [];
  #totalLength = 0;

  /** `maximumTotalLength` is in characters of serialized frames, the memory that matters. */
  constructor(maximumTotalLength: number) {
    this.#maximumTotalLength = maximumTotalLength;
  }

  /** Returns false, and keeps nothing, when the frame does not fit. */
  add(numberedFrame: NumberedFrame): boolean {
    if (this.#totalLength + numberedFrame.frame.length > this.#maximumTotalLength) {
      return false;
    }
    this.#frames.push(numberedFrame);
    this.#totalLength += numberedFrame.frame.length;
    return true;
  }

  /** Forgets every event up to and including `eventNumber`, which the control plane has recorded. */
  forgetThrough(eventNumber: number): void {
    const firstKeptIndex = this.#frames.findIndex((entry) => entry.eventNumber > eventNumber);
    const forgotten = firstKeptIndex === -1 ? this.#frames : this.#frames.slice(0, firstKeptIndex);
    this.#frames = firstKeptIndex === -1 ? [] : this.#frames.slice(firstKeptIndex);
    for (const entry of forgotten) {
      this.#totalLength -= entry.frame.length;
    }
  }

  /** The oldest event still unconfirmed, or undefined when all are confirmed. */
  get oldestEventNumber(): number | undefined {
    return this.#frames[0]?.eventNumber;
  }

  get frames(): readonly NumberedFrame[] {
    return this.#frames;
  }

  get count(): number {
    return this.#frames.length;
  }
}
