/*
 * Announcements that a thread's sandbox began stopping, or the thread began
 * being deleted, on this control plane: how work done for a thread outside
 * its relay (a publication, the model proxy's requests) learns to give up.
 */

/** A thread's sandbox began stopping, or the thread began being deleted, on this control plane. */
export type ThreadEnding = "stop" | "deletion";

export type ThreadEndingListener = (threadId: string, ending: ThreadEnding) => void;

export class ThreadEndings {
  readonly #listeners: ThreadEndingListener[] = [];

  /** Calls `listener` for every ending announced from now on. */
  listen(listener: ThreadEndingListener): void {
    this.#listeners.push(listener);
  }

  announce(threadId: string, ending: ThreadEnding): void {
    for (const listener of this.#listeners) {
      listener(threadId, ending);
    }
  }
}
