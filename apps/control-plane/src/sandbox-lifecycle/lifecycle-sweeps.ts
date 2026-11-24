import type { Logger } from "../logger.js";
import type { IdleSandboxShutdown } from "./idle-sandbox-shutdown.js";
import type { SandboxReconciler } from "./sandbox-reconciler.js";

export type LifecycleSweepsOptions = {
  reconciler: SandboxReconciler;
  idleShutdown: IdleSandboxShutdown;
  intervalInMilliseconds: number;
  logger: Logger;
};

/**
 * Runs reconciliation and idle shutdown: once, fully, as soon as started,
 * and then every interval. The timer only says when to look; what is true
 * is always read from the database and the provider, so nothing is lost
 * when a control plane stops, and a sweep that is slow is not overlapped by
 * the next.
 */
export class LifecycleSweeps {
  readonly #options: LifecycleSweepsOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #sweepUnderWay: Promise<void> | undefined;

  constructor(options: LifecycleSweepsOptions) {
    this.#options = options;
  }

  start(): void {
    this.#sweep({ includeSettledSandboxes: true });
    this.#timer = setInterval(
      () => this.#sweep({ includeSettledSandboxes: false }),
      this.#options.intervalInMilliseconds,
    );
  }

  /** Stops sweeping and waits for a sweep under way to finish. */
  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#sweepUnderWay;
  }

  #sweep(scope: { includeSettledSandboxes: boolean }): void {
    if (this.#sweepUnderWay !== undefined) {
      return;
    }
    const { reconciler, idleShutdown, logger } = this.#options;
    this.#sweepUnderWay = reconciler
      .reconcile(scope)
      .then(() => idleShutdown.stopIdleSandboxes())
      .catch((error: unknown) => {
        logger.error({ err: error }, "A sweep of sandboxes failed; the next one tries again");
      })
      .finally(() => {
        this.#sweepUnderWay = undefined;
      });
  }
}
