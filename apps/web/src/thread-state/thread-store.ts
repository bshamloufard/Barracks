import {
  initialThreadState,
  reduceThreadState,
  type ThreadAction,
  type ThreadState,
} from "./thread-state";

/**
 * Holds one thread's state outside React, so the connection can read the
 * current last seen sequence the moment it reconnects rather than whatever
 * React last rendered. React subscribes to it with `useSyncExternalStore`.
 */
export class ThreadStore {
  #state: ThreadState = initialThreadState;
  readonly #listeners = new Set<() => void>();

  readonly getState = (): ThreadState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  dispatch(action: ThreadAction): void {
    this.#state = reduceThreadState(this.#state, action);
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
