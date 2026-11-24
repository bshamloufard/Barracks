/**
 * Runs asynchronous operations one at a time, each starting only once the
 * one before it has finished, in the order they were added. An operation
 * that fails does not stop the ones after it; its error goes to whoever
 * added it.
 */
export class SerialCommandQueue {
  #lastOperation: Promise<unknown> = Promise.resolve();

  run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#lastOperation.then(operation);
    // The next operation waits for this one to finish, however it finishes;
    // the outcome itself is the caller's to handle.
    this.#lastOperation = result.catch(() => undefined);
    return result;
  }
}
