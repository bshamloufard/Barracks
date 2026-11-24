import type { Clock } from "../sandbox-lifecycle/lifecycle-settings.js";

/** A clock that stands still until a test moves it on, for leases and idle periods. */
export class ControllableClock {
  #now: number;

  constructor(start = new Date("2026-11-24T09:00:00.000Z")) {
    this.#now = start.getTime();
  }

  readonly now: Clock = () => new Date(this.#now);

  advanceBy(milliseconds: number): void {
    this.#now += milliseconds;
  }
}
