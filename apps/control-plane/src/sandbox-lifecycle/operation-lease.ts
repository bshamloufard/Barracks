import { setTimeout as sleep } from "node:timers/promises";
import { SandboxProviderUnavailableError } from "@barrack/sandbox-providers";
import type { Logger } from "../logger.js";
import type { ThreadRecord, ThreadStore } from "../threads/thread-store.js";
import type { Clock, LifecycleTiming } from "./lifecycle-settings.js";

/*
 * The lease a sandbox operation holds on its thread while the provider
 * works, so that another control plane does not take the operation over,
 * and the provider calls made under it, tried again while the provider is
 * unavailable and the lease is still held.
 */

/** Whether the operation's lease has been found lost, so it should try nothing more. */
export type Lease = { isLost: () => boolean };

/** The operation's lease was taken by another control plane: it gives up, recording nothing. */
export class LeaseLostError extends Error {
  constructor() {
    super("Another control plane took over this sandbox operation.");
    this.name = "LeaseLostError";
  }
}

export type OperationLeasesOptions = {
  threadStore: ThreadStore;
  clock: Clock;
  timing: LifecycleTiming;
};

export class OperationLeases {
  readonly #options: OperationLeasesOptions;

  constructor(options: OperationLeasesOptions) {
    this.#options = options;
  }

  /** When a lease taken now would expire. */
  expiry(): Date {
    return new Date(
      this.#options.clock().getTime() + this.#options.timing.leaseDurationInMilliseconds,
    );
  }

  /**
   * Renews the operation's lease while `work` runs, and checks it once more
   * when the work ends. A renewal that finds the thread moved on means the
   * operation was taken over: the provider call under way is let finish,
   * since stopping one part way helps nobody, but `work` is told (through
   * `lease`) to try nothing more, and this throws `LeaseLostError` however
   * the work ended, so its caller records nothing and undoes nothing it is
   * not certain is its own.
   */
  async hold<Result>(
    thread: ThreadRecord,
    logger: Logger,
    work: (lease: Lease) => Promise<Result>,
  ): Promise<Result> {
    let isLost = false;
    const renew = async (): Promise<void> => {
      try {
        const isRenewed = await this.#options.threadStore.renewLease(
          thread.threadId,
          thread.version,
          this.expiry(),
        );
        if (!isRenewed && !isLost) {
          isLost = true;
          logger.warn("Lost the lease on a sandbox operation still under way; giving it up");
        }
      } catch (error) {
        logger.error({ err: error }, "Could not renew a lease");
      }
    };
    const timer = setInterval(() => {
      void renew();
    }, this.#options.timing.leaseRenewalIntervalInMilliseconds);
    let outcome: { result: Result } | { error: unknown };
    try {
      outcome = { result: await work({ isLost: () => isLost }) };
    } catch (error) {
      outcome = { error };
    } finally {
      clearInterval(timer);
    }
    await renew();
    if (isLost) {
      throw new LeaseLostError();
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.result;
  }

  /** Calls the provider, trying again after pauses while it is unavailable and the lease is held. */
  async callProvider<Result>(
    attempt: string,
    lease: Lease,
    logger: Logger,
    call: () => Promise<Result>,
  ): Promise<Result> {
    const delays = this.#options.timing.providerRetryDelaysInMilliseconds;
    for (let attemptIndex = 0; ; attemptIndex += 1) {
      try {
        return await call();
      } catch (error) {
        const delay = delays[attemptIndex];
        if (
          !(error instanceof SandboxProviderUnavailableError) ||
          delay === undefined ||
          lease.isLost()
        ) {
          throw error;
        }
        logger.warn(
          { err: error, attempt, retryDelayInMilliseconds: delay },
          "The sandbox provider is unavailable; trying again",
        );
        await sleep(delay);
      }
    }
  }
}
