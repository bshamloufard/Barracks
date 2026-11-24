/**
 * Runs asynchronous tasks one at a time, in the order they were added. A
 * thread relay pushes everything that must keep its arrival order through one
 * of these, so that, for example, two agent events are recorded and broadcast
 * in the order the supervisor sent them even though recording is asynchronous.
 */
export class SerialTaskQueue {
  #tail: Promise<void> = Promise.resolve();

  /**
   * Adds a task and returns a promise of its outcome. A task that fails does
   * not stop the tasks after it; the returned promise carries its error to
   * the caller, which must handle it.
   */
  enqueue(task: () => Promise<void>): Promise<void> {
    const outcome = this.#tail.then(task);
    this.#tail = outcome.then(
      () => undefined,
      () => undefined,
    );
    return outcome;
  }
}
