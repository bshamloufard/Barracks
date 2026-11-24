import type { ThreadsApi } from "../api/threads-api";
import type { ThreadStore } from "../thread-state/thread-store";
import { reconnectDelayInMilliseconds } from "./reconnect-delay";

/**
 * While a thread's sandbox is being created, how often its record is asked
 * for again. Creation takes from a second (locally) to a minute or more (a
 * cloud provider pulling an image), and a request a second is nothing.
 */
const creatingPollIntervalInMilliseconds = 1_000;

/**
 * Fetches the thread's record into the store, and keeps fetching it while
 * its sandbox is being created, so the page learns when the sandbox is ready
 * or why it failed. The control plane tells nothing of that over the
 * thread's WebSocket: creation happens once in a thread's life, so asking is
 * simpler than a message pushed for it. Failed fetches are tried again after
 * a growing delay.
 */
export class ThreadRecordPoller {
  readonly #threadId: string;
  readonly #store: ThreadStore;
  readonly #threadsApi: ThreadsApi;
  readonly #whenFound: () => void;
  #hasBeenFound = false;
  #failedAttemptCount = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #isStopped = false;

  /** `whenFound` is called once, the first time the record arrives. */
  constructor(threadId: string, store: ThreadStore, threadsApi: ThreadsApi, whenFound: () => void) {
    this.#threadId = threadId;
    this.#store = store;
    this.#threadsApi = threadsApi;
    this.#whenFound = whenFound;
  }

  start(): void {
    void this.#poll();
  }

  stop(): void {
    this.#isStopped = true;
    clearTimeout(this.#timer);
  }

  async #poll(): Promise<void> {
    try {
      const thread = await this.#threadsApi.fetchThread(this.#threadId);
      if (this.#isStopped) {
        return;
      }
      this.#failedAttemptCount = 0;
      if (thread === undefined) {
        this.#store.dispatch({ type: "thread_record_missing" });
        return;
      }
      this.#store.dispatch({ type: "thread_record_loaded", thread });
      if (!this.#hasBeenFound) {
        this.#hasBeenFound = true;
        this.#whenFound();
      }
      if (thread.sandbox.state === "creating") {
        this.#pollAgainIn(creatingPollIntervalInMilliseconds);
      }
    } catch (error) {
      console.error(error);
      this.#pollAgainIn(reconnectDelayInMilliseconds(this.#failedAttemptCount));
      this.#failedAttemptCount += 1;
    }
  }

  #pollAgainIn(delayInMilliseconds: number): void {
    if (this.#isStopped) {
      return;
    }
    this.#timer = setTimeout(() => void this.#poll(), delayInMilliseconds);
  }
}
