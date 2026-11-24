/**
 * How much one control plane instance relays, so that one thread's traffic
 * can neither starve the others nor exhaust the instance. An agent sends
 * one request at a time, retrying with pauses, and its answers take
 * seconds; these leave it ample room and stop anything else early, before
 * the database is asked anything about a request.
 */
export type ModelProxyLimits = {
  /** Requests relayed at once for one thread. */
  concurrentRequestsPerThread: number;
  /** Requests relayed at once by this instance, for every thread together. */
  concurrentRequestsInTotal: number;
  /** Requests one thread may start in a burst, refilled at `requestsPerSecondPerThread`. */
  requestBurstPerThread: number;
  requestsPerSecondPerThread: number;
  /** The largest request body relayed: Anthropic's own limit for a Messages request is 32 MB. */
  maximumRequestBytes: number;
  /** The largest answer relayed, decompressed. */
  maximumResponseBytes: number;
  /** How long the provider may take to start answering. */
  firstByteTimeoutInMilliseconds: number;
  /** How long either side may stay silent mid-request or mid-answer (the agent's own client waits 5 minutes). */
  idleTimeoutInMilliseconds: number;
  /** How long one request may take in all. */
  totalTimeoutInMilliseconds: number;
};

export const defaultModelProxyLimits: ModelProxyLimits = {
  concurrentRequestsPerThread: 4,
  concurrentRequestsInTotal: 256,
  requestBurstPerThread: 20,
  requestsPerSecondPerThread: 2,
  maximumRequestBytes: 32 * 1024 * 1024,
  maximumResponseBytes: 64 * 1024 * 1024,
  firstByteTimeoutInMilliseconds: 5 * 60_000,
  idleTimeoutInMilliseconds: 5 * 60_000,
  totalTimeoutInMilliseconds: 60 * 60_000,
};

type ThreadAllowance = { inFlight: number; tokens: number; refilledAt: number };

const maximumRememberedThreads = 10_000;

/**
 * Admits requests within the limits. Every admission is released exactly
 * once, by whoever holds it, when its request ends however it ends.
 */
export class ModelProxyAdmissions {
  readonly #limits: ModelProxyLimits;
  readonly #clock: () => number;
  readonly #threads = new Map<string, ThreadAllowance>();
  #inFlightInTotal = 0;

  constructor(limits: ModelProxyLimits, clock: () => number = Date.now) {
    this.#limits = limits;
    this.#clock = clock;
  }

  get inFlightInTotal(): number {
    return this.#inFlightInTotal;
  }

  /** An admission to release, or why there is none. */
  admit(
    threadId: string,
  ): { kind: "admitted"; release: () => void } | { kind: "thread_busy" | "instance_busy" } {
    const allowance = this.#refilledAllowance(threadId);
    if (allowance.inFlight >= this.#limits.concurrentRequestsPerThread || allowance.tokens < 1) {
      this.#forgetIfIdle(threadId, allowance);
      return { kind: "thread_busy" };
    }
    if (this.#inFlightInTotal >= this.#limits.concurrentRequestsInTotal) {
      this.#forgetIfIdle(threadId, allowance);
      return { kind: "instance_busy" };
    }
    allowance.tokens -= 1;
    allowance.inFlight += 1;
    this.#inFlightInTotal += 1;
    let isReleased = false;
    return {
      kind: "admitted",
      release: () => {
        if (isReleased) {
          return;
        }
        isReleased = true;
        allowance.inFlight -= 1;
        this.#inFlightInTotal -= 1;
        this.#forgetIfIdle(threadId, allowance);
      },
    };
  }

  #refilledAllowance(threadId: string): ThreadAllowance {
    const now = this.#clock();
    const allowance = this.#threads.get(threadId) ?? {
      inFlight: 0,
      tokens: this.#limits.requestBurstPerThread,
      refilledAt: now,
    };
    const refill = ((now - allowance.refilledAt) / 1000) * this.#limits.requestsPerSecondPerThread;
    allowance.tokens = Math.min(this.#limits.requestBurstPerThread, allowance.tokens + refill);
    allowance.refilledAt = now;
    this.#threads.set(threadId, allowance);
    return allowance;
  }

  /**
   * A thread with nothing in flight and a full allowance needs no entry. One
   * left part-spent is dropped once there are many: forgetting it only
   * gives that thread a fresh burst, so the map stays small whatever comes.
   */
  #forgetIfIdle(threadId: string, allowance: ThreadAllowance): void {
    if (allowance.inFlight === 0 && allowance.tokens >= this.#limits.requestBurstPerThread) {
      this.#threads.delete(threadId);
    }
    if (this.#threads.size <= maximumRememberedThreads) {
      return;
    }
    for (const [rememberedThreadId, remembered] of this.#threads) {
      if (remembered.inFlight === 0) {
        this.#threads.delete(rememberedThreadId);
      }
    }
  }
}
