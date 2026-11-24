/**
 * How much one control plane instance relays, so that one thread's traffic
 * can neither starve the others nor exhaust the instance. An agent sends
 * one request at a time, retrying with pauses, and its answers take
 * seconds; these leave it ample room and stop anything else early.
 *
 * Two kinds of limit, in the order a request meets them: before a caller is
 * authenticated, only the instance's bound on token lookups (anyone can
 * name any thread, so nothing they send may spend that thread's
 * allowance); once its token is accepted, the thread's own allowance.
 */
export type ModelProxyLimits = {
  /** Token lookups under way at once for callers not yet authenticated, on this instance. */
  authenticationsInFlight: number;
  /** Token lookups this instance makes in a burst, refilled at `authenticationsPerSecond`. */
  authenticationBurst: number;
  authenticationsPerSecond: number;
  /** Requests relayed at once for one thread. */
  concurrentRequestsPerThread: number;
  /** Requests relayed at once by this instance, for every thread together. */
  concurrentRequestsInTotal: number;
  /** Requests one thread may start in a burst, refilled at `requestsPerSecondPerThread`. */
  requestBurstPerThread: number;
  requestsPerSecondPerThread: number;
  /**
   * The largest request body relayed. Anthropic's own limit for a Messages
   * request is 32 MB, and the pinned Pi can come close: a conversation of a
   * million tokens is about 4 MB of text, and the computer tool sends up to
   * six 1280x800 screenshots, each a few kilobytes of base64 for a page of
   * text, about 0.8 MB for a smooth photograph and 4.1 MB at worst; images
   * the agent reads from files are up to 4.5 MB each. See the decision log.
   */
  maximumRequestBytes: number;
  /**
   * Request bodies held by this instance at once, each read whole before it
   * is relayed; set by `BARRACK_MODEL_PROXY_REQUEST_BODIES_MEBIBYTES`.
   */
  maximumRequestBytesHeldInTotal: number;
  /**
   * How long a request's whole body may take to arrive. The agent sends a
   * body from memory at once; three minutes is the largest body at about
   * 1.5 Mbit/s, and bounds how long any request can hold its share of the
   * bytes held while sending nothing worth relaying.
   */
  requestBodyDeadlineInMilliseconds: number;
  /** The largest answer relayed, decompressed. */
  maximumResponseBytes: number;
  /** How long the provider may take to start answering. */
  firstByteTimeoutInMilliseconds: number;
  /** How long either side may stay silent mid-request or mid-answer (the agent's own client waits 5 minutes). */
  idleTimeoutInMilliseconds: number;
  /** How long one request may take in all. */
  totalTimeoutInMilliseconds: number;
  /** How often a request in flight is checked against the records again. */
  reauthorizationIntervalInMilliseconds: number;
};

export const defaultModelProxyLimits: ModelProxyLimits = {
  authenticationsInFlight: 32,
  authenticationBurst: 200,
  authenticationsPerSecond: 100,
  concurrentRequestsPerThread: 4,
  concurrentRequestsInTotal: 256,
  requestBurstPerThread: 20,
  requestsPerSecondPerThread: 2,
  maximumRequestBytes: 32 * 1024 * 1024,
  maximumRequestBytesHeldInTotal: 128 * 1024 * 1024,
  requestBodyDeadlineInMilliseconds: 3 * 60_000,
  maximumResponseBytes: 64 * 1024 * 1024,
  firstByteTimeoutInMilliseconds: 5 * 60_000,
  idleTimeoutInMilliseconds: 5 * 60_000,
  totalTimeoutInMilliseconds: 60 * 60_000,
  reauthorizationIntervalInMilliseconds: 30_000,
};

/** A token bucket: `tokens` left as of `refilledAt`. */
type Bucket = { tokens: number; refilledAt: number };

type ThreadAllowance = Bucket & { inFlight: number };

/** Beyond this many remembered threads, those whose allowance has refilled are forgotten. */
const defaultMaximumRememberedThreads = 10_000;

/**
 * Admits an authenticated thread's requests within its limits. Every
 * admission is released exactly once, by whoever holds it, when its request
 * ends however it ends.
 */
export class ModelProxyAdmissions {
  readonly #limits: ModelProxyLimits;
  readonly #clock: () => number;
  readonly #maximumRememberedThreads: number;
  readonly #threads = new Map<string, ThreadAllowance>();
  #inFlightInTotal = 0;

  constructor(
    limits: ModelProxyLimits,
    clock: () => number = Date.now,
    maximumRememberedThreads = defaultMaximumRememberedThreads,
  ) {
    this.#limits = limits;
    this.#clock = clock;
    this.#maximumRememberedThreads = maximumRememberedThreads;
  }

  get inFlightInTotal(): number {
    return this.#inFlightInTotal;
  }

  /** An admission to release, or why there is none. Only for a thread whose token was accepted. */
  admit(
    threadId: string,
  ): { kind: "admitted"; release: () => void } | { kind: "thread_busy" | "instance_busy" } {
    const allowance = this.#refilledAllowance(threadId);
    if (allowance.inFlight >= this.#limits.concurrentRequestsPerThread || allowance.tokens < 1) {
      this.#forgetRefilled();
      return { kind: "thread_busy" };
    }
    if (this.#inFlightInTotal >= this.#limits.concurrentRequestsInTotal) {
      this.#forgetRefilled();
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
        this.#forgetRefilled();
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
    refill(
      allowance,
      now,
      this.#limits.requestBurstPerThread,
      this.#limits.requestsPerSecondPerThread,
    );
    this.#threads.set(threadId, allowance);
    return allowance;
  }

  /**
   * Once many threads are remembered, those with nothing in flight whose
   * allowance would by now have refilled are forgotten: forgetting one is
   * the same as remembering it full. A thread whose allowance is still
   * part-spent is never forgotten, so no number of other threads can give
   * it a fresh burst; and only threads with an accepted token are here, so
   * the map holds at most the running threads' worth.
   */
  #forgetRefilled(): void {
    if (this.#threads.size <= this.#maximumRememberedThreads) {
      return;
    }
    const now = this.#clock();
    const { requestBurstPerThread, requestsPerSecondPerThread } = this.#limits;
    for (const [threadId, allowance] of this.#threads) {
      const refilled = { ...allowance };
      refill(refilled, now, requestBurstPerThread, requestsPerSecondPerThread);
      if (allowance.inFlight === 0 && refilled.tokens >= requestBurstPerThread) {
        this.#threads.delete(threadId);
      }
    }
  }
}

/**
 * The instance's bound on token lookups for callers not yet authenticated:
 * a request presenting a token is looked up in the database, whoever sent
 * it and whatever thread it names, so without this anyone could make the
 * control plane query its database as fast as they could send. One bound for
 * the whole instance rather than per caller, because the caller's address
 * cannot be trusted behind a hosting provider's proxy (see the decision
 * log); past it a request is refused as busy, which the agent retries.
 */
export class AuthenticationAllowance {
  readonly #limits: ModelProxyLimits;
  readonly #clock: () => number;
  readonly #bucket: Bucket;
  #inFlight = 0;

  constructor(limits: ModelProxyLimits, clock: () => number = Date.now) {
    this.#limits = limits;
    this.#clock = clock;
    this.#bucket = { tokens: limits.authenticationBurst, refilledAt: clock() };
  }

  /** Lookups under way now. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Room for one lookup, to leave once it is done, or none. */
  enter(): { kind: "entered"; leave: () => void } | { kind: "busy" } {
    refill(
      this.#bucket,
      this.#clock(),
      this.#limits.authenticationBurst,
      this.#limits.authenticationsPerSecond,
    );
    if (this.#inFlight >= this.#limits.authenticationsInFlight || this.#bucket.tokens < 1) {
      return { kind: "busy" };
    }
    this.#bucket.tokens -= 1;
    this.#inFlight += 1;
    let hasLeft = false;
    return {
      kind: "entered",
      leave: () => {
        if (!hasLeft) {
          hasLeft = true;
          this.#inFlight -= 1;
        }
      },
    };
  }
}

function refill(bucket: Bucket, now: number, burst: number, perSecond: number): void {
  const refilled = ((now - bucket.refilledAt) / 1000) * perSecond;
  bucket.tokens = Math.min(burst, bucket.tokens + refilled);
  bucket.refilledAt = now;
}
