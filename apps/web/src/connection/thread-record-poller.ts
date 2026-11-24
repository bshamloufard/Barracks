import type { ThreadSummary } from "@barrack/protocol";
import type { ThreadsApi } from "../api/threads-api";
import { isSandboxChanging } from "../presentation/describe-sandbox";
import type { ThreadStore } from "../thread-state/thread-store";
import { reconnectDelayInMilliseconds } from "./reconnect-delay";

/**
 * While a thread's sandbox is changing state (being created, woken, stopped
 * or deleted), how often its record is asked for again. Starting takes from
 * a second (locally) to a minute or more (a cloud provider restoring an
 * archived sandbox), and a request a second is nothing.
 */
const changingPollIntervalInMilliseconds = 1_000;

/**
 * Otherwise, how often: often enough to notice the sandbox stopped for being
 * idle, or by another device, while the page sits open.
 */
const settledPollIntervalInMilliseconds = 15_000;

/** How soon a refresh asked for happens, so several asked for together make one. */
const refreshDelayInMilliseconds = 250;

/**
 * Fetches the thread's record into the store, and keeps fetching it, often
 * while its sandbox is changing state and now and then otherwise, so the
 * page learns when it is running, stopped or gone, and why. The thread's
 * WebSocket tells nothing of that; `refreshNow` is called when something
 * seen on it suggests the record changed (the supervisor coming or going, a
 * message waking the sandbox). Failed fetches are tried again after a
 * growing delay.
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

  /**
   * Fetches the record shortly instead of when next due. Calls close
   * together, such as for each message of a replay, make one fetch.
   */
  refreshNow(): void {
    this.#pollAgainIn(refreshDelayInMilliseconds);
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
      this.#noticeFound();
      this.#pollAgainIn(pollIntervalFor(thread));
    } catch (error) {
      console.error(error);
      this.#pollAgainIn(reconnectDelayInMilliseconds(this.#failedAttemptCount));
      this.#failedAttemptCount += 1;
    }
  }

  #noticeFound(): void {
    if (!this.#hasBeenFound) {
      this.#hasBeenFound = true;
      this.#whenFound();
    }
  }

  #pollAgainIn(delayInMilliseconds: number): void {
    if (this.#isStopped) {
      return;
    }
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#poll(), delayInMilliseconds);
  }
}

function pollIntervalFor(thread: ThreadSummary): number {
  return isSandboxChanging(thread.sandbox)
    ? changingPollIntervalInMilliseconds
    : settledPollIntervalInMilliseconds;
}
