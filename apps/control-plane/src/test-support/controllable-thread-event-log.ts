import type { RecordedThreadEvent, ThreadEvent } from "@barrack/protocol";
import { InMemoryThreadEventLog } from "../thread-event-log/in-memory-thread-event-log.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";

/** A pause that the test ends by calling `release`. */
export class Gate {
  readonly #reached = Promise.withResolvers<void>();
  readonly #released = Promise.withResolvers<void>();

  /** Resolves when the paused code arrives at the gate. */
  get reached(): Promise<void> {
    return this.#reached.promise;
  }

  /** Called by the code being paused: resolves once the test releases the gate. */
  async pass(): Promise<void> {
    this.#reached.resolve();
    await this.#released.promise;
  }

  release(): void {
    this.#released.resolve();
  }
}

export type ReadGates = {
  /** Holds the read before it looks at the log. */
  beforeReading: Gate;
  /** Holds the read after it has looked at the log but before it returns. */
  afterReading: Gate;
};

/**
 * An in-memory log whose next read or append can be paused, so a test can
 * make events arrive at exactly the moment a race would happen in production,
 * when the log is a database round trip away. Its next append or read can
 * also be made to fail, as a database query can.
 */
export class ControllableThreadEventLog implements ThreadEventLog {
  readonly #log = new InMemoryThreadEventLog();
  #nextReadGates: ReadGates | undefined;
  #nextAppendGate: Gate | undefined;
  #nextAppendFailure: Error | undefined;
  #nextReadFailure: Error | undefined;

  holdNextRead(): ReadGates {
    const gates = { beforeReading: new Gate(), afterReading: new Gate() };
    this.#nextReadGates = gates;
    return gates;
  }

  holdNextAppend(): Gate {
    const gate = new Gate();
    this.#nextAppendGate = gate;
    return gate;
  }

  /** Makes the next append record nothing and reject with `failure`. */
  failNextAppend(failure: Error): void {
    this.#nextAppendFailure = failure;
  }

  /** Makes the next read reject with `failure`. */
  failNextRead(failure: Error): void {
    this.#nextReadFailure = failure;
  }

  async append(threadId: string, event: ThreadEvent): Promise<RecordedThreadEvent> {
    const gate = this.#nextAppendGate;
    this.#nextAppendGate = undefined;
    await gate?.pass();
    const failure = this.#nextAppendFailure;
    this.#nextAppendFailure = undefined;
    if (failure !== undefined) {
      throw failure;
    }
    return this.#log.append(threadId, event);
  }

  async readAfter(threadId: string, afterSequence: number): Promise<RecordedThreadEvent[]> {
    const gates = this.#nextReadGates;
    this.#nextReadGates = undefined;
    await gates?.beforeReading.pass();
    const failure = this.#nextReadFailure;
    this.#nextReadFailure = undefined;
    if (failure !== undefined) {
      throw failure;
    }
    const events = await this.#log.readAfter(threadId, afterSequence);
    await gates?.afterReading.pass();
    return events;
  }
}
