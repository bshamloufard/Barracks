import type { Logger } from "../logger.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import { SupervisorBacklog } from "./supervisor-backlog.js";

/*
 * A thread relay's one queue. Everything that records a thread event, or
 * must keep its order among those that do, waits here and runs one task at
 * a time, in arrival order, so the thread's events are recorded and
 * broadcast in the order they arrived. What a thread's supervisors make
 * wait here is bounded (`SupervisorBacklog`), since a sandbox is untrusted.
 */

export type RelayQueueOptions = {
  logger: Logger;
  /** Called after each task settles, however it ended. */
  whenTaskSettled: () => void;
};

export class RelayQueue {
  readonly #logger: Logger;
  readonly #whenTaskSettled: () => void;
  readonly #tasks = new SerialTaskQueue();
  #queuedTaskCount = 0;
  readonly #supervisorBacklog = new SupervisorBacklog();

  constructor(options: RelayQueueOptions) {
    this.#logger = options.logger;
    this.#whenTaskSettled = options.whenTaskSettled;
  }

  /** No task is waiting or running. */
  get isIdle(): boolean {
    return this.#queuedTaskCount === 0;
  }

  /** How many characters of supervisor messages, and of stream fragments, are waiting. */
  get queuedSupervisorLengths(): { messages: number; fragments: number } {
    return this.#supervisorBacklog.queuedLengths;
  }

  /** Queues `task`; if it fails, the failure is logged as failing to `description`. */
  enqueue(description: string, task: () => Promise<void>): void {
    this.#queuedTaskCount += 1;
    this.#tasks
      .enqueue(task)
      .catch((error: unknown) => {
        this.#logger.error({ err: error }, `Failed to ${description}`);
      })
      .finally(() => {
        this.#queuedTaskCount -= 1;
        this.#whenTaskSettled();
      });
  }

  /** Queues `task` and returns its outcome, for the caller to handle. */
  enqueueAndWait(task: () => Promise<void>): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.enqueue("carry out a task whose caller handles its failure", async () => {
      try {
        await task();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    return promise;
  }

  /**
   * Queues a supervisor's message, of `frameLength` characters, unless the
   * messages already waiting leave no room for it; returns whether it did.
   */
  enqueueSupervisorMessage(
    frameLength: number,
    description: string,
    task: () => Promise<void>,
  ): boolean {
    if (!this.#supervisorBacklog.admitMessage(frameLength)) {
      return false;
    }
    this.enqueue(description, async () => {
      try {
        await task();
      } finally {
        this.#supervisorBacklog.releaseMessage(frameLength);
      }
    });
    return true;
  }

  /**
   * Queues a stream fragment of the assistant message `messageId` unless
   * fragments have spent their own budget; returns whether it did. A
   * fragment's room is given back as soon as its turn comes.
   */
  enqueueStreamFragment(
    messageId: string,
    frameLength: number,
    description: string,
    task: () => Promise<void>,
  ): boolean {
    if (!this.#supervisorBacklog.admitFragment(messageId, frameLength)) {
      return false;
    }
    this.enqueue(description, async () => {
      this.#supervisorBacklog.releaseFragment(frameLength);
      await task();
    });
    return true;
  }
}
