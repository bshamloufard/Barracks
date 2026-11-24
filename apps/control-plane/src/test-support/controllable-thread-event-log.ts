import type { RecordedThreadEvent, ThreadEvent } from "@barrack/protocol";
import { InMemoryThreadEventLog } from "../thread-event-log/in-memory-thread-event-log.js";
import type { ThreadEventLog, ThreadEventPage } from "../thread-event-log/thread-event-log.js";

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

export type AppendGates = {
  /** Holds the append before it records anything. */
  beforeRecording: Gate;
  /** Holds the append after the event is recorded but before it returns, as a slow database reply would. */
  afterRecording: Gate;
};

/**
 * An in-memory log whose next append, or next read of a thread's newest
 * sequence, can be paused, so a test can make events arrive at exactly the
 * moment a race would happen in production, when the log is a database
 * round trip away. Its next append or read can also be made to fail, as a
 * database query can.
 */
export class ControllableThreadEventLog implements ThreadEventLog {
  readonly #log = new InMemoryThreadEventLog();
  #nextNewestSequenceReadGates: ReadGates | undefined;
  #nextAppendGates: AppendGates | undefined;
  #nextAppendFailure: Error | undefined;
  #nextReadFailure: Error | undefined;

  /** A replay reads the newest sequence first, to fix the range it announces. */
  holdNextNewestSequenceRead(): ReadGates {
    const gates = { beforeReading: new Gate(), afterReading: new Gate() };
    this.#nextNewestSequenceReadGates = gates;
    return gates;
  }

  holdNextAppend(): AppendGates {
    const gates = { beforeRecording: new Gate(), afterRecording: new Gate() };
    this.#nextAppendGates = gates;
    return gates;
  }

  /** Makes the next append record nothing and reject with `failure`. */
  failNextAppend(failure: Error): void {
    this.#nextAppendFailure = failure;
  }

  /** Makes the next read of either kind reject with `failure`. */
  failNextRead(failure: Error): void {
    this.#nextReadFailure = failure;
  }

  async append(threadId: string, event: ThreadEvent): Promise<RecordedThreadEvent> {
    const gates = this.#nextAppendGates;
    this.#nextAppendGates = undefined;
    await gates?.beforeRecording.pass();
    const failure = this.#nextAppendFailure;
    this.#nextAppendFailure = undefined;
    if (failure !== undefined) {
      throw failure;
    }
    const recordedEvent = await this.#log.append(threadId, event);
    await gates?.afterRecording.pass();
    return recordedEvent;
  }

  async readNewestSequence(threadId: string): Promise<number> {
    const gates = this.#nextNewestSequenceReadGates;
    this.#nextNewestSequenceReadGates = undefined;
    await gates?.beforeReading.pass();
    this.#throwNextReadFailure();
    const newestSequence = await this.#log.readNewestSequence(threadId);
    await gates?.afterReading.pass();
    return newestSequence;
  }

  async readEvents(threadId: string, page: ThreadEventPage): Promise<RecordedThreadEvent[]> {
    this.#throwNextReadFailure();
    return this.#log.readEvents(threadId, page);
  }

  #throwNextReadFailure(): void {
    const failure = this.#nextReadFailure;
    this.#nextReadFailure = undefined;
    if (failure !== undefined) {
      throw failure;
    }
  }
}
