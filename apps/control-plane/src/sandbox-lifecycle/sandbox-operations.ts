import { setTimeout as sleep } from "node:timers/promises";
import {
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
  type SandboxProvider,
  SandboxProviderUnavailableError,
} from "@barrack/sandbox-providers";
import type { Logger } from "../logger.js";
import type { OpenRun, ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import {
  buildSupervisorEnvironment,
  type SupervisorEnvironmentSettings,
} from "../threads/supervisor-environment.js";
import { type MintedSupervisorToken, mintSupervisorToken } from "../threads/supervisor-token.js";
import type {
  ThreadRecord,
  ThreadSandboxRecord,
  ThreadStore,
  TransitionOutcome,
} from "../threads/thread-store.js";
import {
  describeProviderFailure,
  runEndedBySandboxStoppingMessage,
  runEndedByStopMessage,
  sandboxLostReason,
} from "./lifecycle-messages.js";
import type { Clock, LifecycleTiming } from "./lifecycle-settings.js";
import type { ThreadRuns } from "./thread-runs.js";

export type SandboxOperationsOptions = {
  threadStore: ThreadStore;
  threadEventLog: ThreadEventLog;
  sandboxProvider: SandboxProvider;
  supervisorEnvironment: SupervisorEnvironmentSettings;
  threadRuns: ThreadRuns;
  clock: Clock;
  timing: LifecycleTiming;
  logger: Logger;
};

/** How often a stop checks whether an interrupted run has ended. */
const interruptCheckIntervalInMilliseconds = 100;

/**
 * Carries out what a thread's state says is under way (`creating`,
 * `starting`, `stopping` or `deleting`) by asking the provider, and records
 * how it ended. Whoever moved the thread into that state hands it here, as
 * does reconciliation when it takes over an operation whose control plane
 * has gone; every step is safe to repeat, since a provider starting a
 * running sandbox, stopping a stopped one or destroying a missing one does
 * nothing.
 *
 * While the provider works, the operation's lease is renewed, so another
 * control plane does not take it over. Every outcome is recorded with the
 * version the operation was handed, so one taken over or overtaken records
 * nothing; and a provider operation that fails leaves the thread in the
 * state the provider then reports, with a reason the user is shown, never
 * stuck in one under way.
 */
export class SandboxOperations {
  readonly #options: SandboxOperationsOptions;
  readonly #operationsUnderWay = new Set<Promise<void>>();

  constructor(options: SandboxOperationsOptions) {
    this.#options = options;
  }

  /**
   * Starts the operation in the background and returns at once; it never
   * rejects. `supervisorToken` is given only for a creation just recorded
   * with that token's digest.
   */
  carryOut(thread: ThreadRecord, supervisorToken?: MintedSupervisorToken): void {
    const logger = this.#loggerFor(thread);
    const operation = this.#perform(thread, supervisorToken, logger).catch((error: unknown) => {
      logger.error(
        { err: error, sandboxState: thread.sandbox.state },
        "A sandbox operation failed unexpectedly; once its lease expires, reconciliation takes it over",
      );
    });
    this.#operationsUnderWay.add(operation);
    void operation.finally(() => this.#operationsUnderWay.delete(operation));
  }

  /** Resolves once every operation started so far has finished, however it ended. */
  async whenSettled(): Promise<void> {
    while (this.#operationsUnderWay.size > 0) {
      await Promise.all(this.#operationsUnderWay);
    }
  }

  /** When a lease taken now would expire. */
  leaseExpiry(): Date {
    return new Date(
      this.#options.clock().getTime() + this.#options.timing.leaseDurationInMilliseconds,
    );
  }

  async #perform(
    thread: ThreadRecord,
    supervisorToken: MintedSupervisorToken | undefined,
    logger: Logger,
  ): Promise<void> {
    const { sandbox } = thread;
    switch (sandbox.state) {
      case "creating":
        await this.#create(thread, supervisorToken, logger);
        return;
      case "starting":
        await this.#start(thread, sandbox.sandboxId, logger);
        return;
      case "stopping":
        await this.#stop(thread, sandbox.sandboxId, logger);
        return;
      case "deleting":
        await this.#delete(thread, sandbox.sandboxId, logger);
        return;
      default:
        logger.error({ sandboxState: sandbox.state }, "No operation is under way in this state");
    }
  }

  /**
   * A creation taken over from a control plane that has gone lost the token
   * that control plane minted, so it mints another and adds its digest to
   * those the thread accepts before asking for a sandbox, so that a
   * supervisor made with it can connect at once. A sandbox that turns up
   * already made holds the token of whichever attempt made it (this one's,
   * if a request that seemed to fail went through, or an earlier one's),
   * and every one of those is still accepted.
   */
  async #create(
    handedOver: ThreadRecord,
    givenToken: MintedSupervisorToken | undefined,
    logger: Logger,
  ): Promise<void> {
    const isTakenOver = givenToken === undefined;
    const token = givenToken ?? mintSupervisorToken();
    const thread = isTakenOver ? await this.#recordNewToken(handedOver, token, logger) : handedOver;
    if (thread === undefined) {
      return;
    }
    let outcome: SandboxRequestOutcome;
    try {
      outcome = await this.#withLease(thread, logger, () =>
        this.#requestSandbox(thread.threadId, token.token, isTakenOver, logger),
      );
    } catch (error) {
      logger.error({ err: error }, "Could not create the thread's sandbox");
      await this.#record(thread, logger, {
        state: "failed",
        sandboxId: undefined,
        reason: `${describeProviderFailure("Its sandbox could not be created", error)} Delete this thread and create a new one to try again.`,
      });
      return;
    }
    const recorded = await this.#record(thread, logger, {
      state: "running",
      sandboxId: outcome.sandboxId,
      problem: undefined,
    });
    if (recorded.kind === "changed") {
      logger.info({ sandboxId: outcome.sandboxId }, "The thread's sandbox is running");
      return;
    }
    await this.#removeUnrecordedSandbox(thread.threadId, outcome, logger);
  }

  /** Returns the thread as recorded accepting the new token, or undefined if it moved on. */
  async #recordNewToken(
    thread: ThreadRecord,
    token: MintedSupervisorToken,
    logger: Logger,
  ): Promise<ThreadRecord | undefined> {
    const outcome = await this.#recordTransition(
      {
        threadId: thread.threadId,
        fromVersion: thread.version,
        to: { state: "creating", leaseExpiresAt: this.leaseExpiry() },
        at: this.#options.clock(),
        addedSupervisorTokenDigest: token.digest,
      },
      logger,
    );
    return outcome.kind === "changed" ? outcome.thread : undefined;
  }

  /**
   * A sandbox that already exists for the thread on a later attempt (a
   * request that timed out but went through), or on a creation taken over,
   * can only be one an earlier attempt made, and is the thread's. On the
   * first attempt of a new thread there is no such explanation, so it is a
   * failure.
   */
  async #requestSandbox(
    threadId: string,
    supervisorToken: string,
    mayFindEarlierSandbox: boolean,
    logger: Logger,
  ): Promise<SandboxRequestOutcome> {
    const supervisorEnvironment = buildSupervisorEnvironment(
      this.#options.supervisorEnvironment,
      threadId,
      supervisorToken,
    );
    let attemptCount = 0;
    try {
      return await this.#callProvider("create the sandbox", logger, async () => {
        attemptCount += 1;
        const { sandboxId } = await this.#options.sandboxProvider.create({
          threadId,
          supervisorEnvironment,
        });
        return { sandboxId, wasMadeEarlier: false };
      });
    } catch (error) {
      if (
        !(error instanceof SandboxAlreadyExistsError) ||
        (!mayFindEarlierSandbox && attemptCount === 1)
      ) {
        throw error;
      }
      const sandboxId = error.existingSandboxId;
      logger.warn(
        { sandboxId },
        "An earlier attempt created the thread's sandbox; making sure it runs",
      );
      await this.#callProvider("start the sandbox", logger, () =>
        this.#options.sandboxProvider.start(sandboxId),
      );
      return { sandboxId, wasMadeEarlier: true };
    }
  }

  /**
   * The creation was taken over or overtaken (the thread deleted, say). A
   * sandbox this attempt made, that the thread's record does not name, would
   * otherwise run unrecorded, so it is destroyed; one an earlier attempt
   * made is left to whoever holds the thread now.
   */
  async #removeUnrecordedSandbox(
    threadId: string,
    outcome: SandboxRequestOutcome,
    logger: Logger,
  ): Promise<void> {
    const current = await this.#options.threadStore.find(threadId);
    const isRecorded = current !== undefined && sandboxIdOf(current.sandbox) === outcome.sandboxId;
    if (isRecorded || outcome.wasMadeEarlier) {
      return;
    }
    logger.warn(
      { sandboxId: outcome.sandboxId },
      "The thread's record moved on while its sandbox was being created; destroying the sandbox so that it is not left running unrecorded",
    );
    try {
      await this.#options.sandboxProvider.destroy(outcome.sandboxId);
    } catch (error) {
      logger.error(
        { err: error, sandboxId: outcome.sandboxId },
        "Could not destroy the unrecorded sandbox; it is left behind and must be removed by hand",
      );
    }
  }

  async #start(thread: ThreadRecord, sandboxId: string, logger: Logger): Promise<void> {
    try {
      await this.#withLease(thread, logger, () =>
        this.#callProvider("start the sandbox", logger, () =>
          this.#options.sandboxProvider.start(sandboxId),
        ),
      );
    } catch (error) {
      await this.#settleAfterFailure(
        thread,
        sandboxId,
        describeProviderFailure("Its sandbox could not be started", error),
        error,
        logger,
      );
      return;
    }
    const recorded = await this.#record(thread, logger, {
      state: "running",
      sandboxId,
      problem: undefined,
    });
    if (recorded.kind === "changed") {
      logger.info({ sandboxId }, "The thread's sandbox is running again");
    }
  }

  /**
   * Interrupts the agent's open run first, so that the run ends as the
   * agent reports it, then stops the sandbox with its files kept, then
   * closes in history any run that is still open, since the agent can no
   * longer end it. Meanwhile the agent is handed no user messages; one that
   * arrived wakes the sandbox again once it has stopped.
   *
   * The run to close is read once the sandbox has stopped, and closed only
   * once the stop is recorded at the operation's version, so it is the
   * stopped agent's run and not one a sandbox woken since has opened.
   */
  async #stop(thread: ThreadRecord, sandboxId: string, logger: Logger): Promise<void> {
    const { threadRuns } = this.#options;
    threadRuns.prepareForStop(thread.threadId);
    try {
      await this.#waitForInterruptedRun(thread.threadId, logger);
      await this.#withLease(thread, logger, () =>
        this.#callProvider("stop the sandbox", logger, () =>
          this.#options.sandboxProvider.stop(sandboxId),
        ),
      );
    } catch (error) {
      await this.#settleAfterFailure(
        thread,
        sandboxId,
        describeProviderFailure("Its sandbox could not be stopped", error),
        error,
        logger,
      );
      return;
    } finally {
      threadRuns.finishStop(thread.threadId);
    }
    const openRun = await this.#readOpenRun(thread.threadId, logger);
    const finished = await this.#options.threadStore.finishStopping({
      threadId: thread.threadId,
      fromVersion: thread.version,
      wakeLeaseExpiresAt: this.leaseExpiry(),
    });
    if (finished.kind !== "changed") {
      logger.warn(
        "The thread's record moved on while its sandbox was stopping; leaving it as it is",
      );
      return;
    }
    await this.#closeOpenRun(thread.threadId, openRun, runEndedByStopMessage, logger);
    logger.info({ sandboxId }, "The thread's sandbox is stopped");
    if (finished.thread.sandbox.state === "starting") {
      logger.info("A message arrived while the sandbox was stopping; waking it again");
      await this.#start(finished.thread, sandboxId, logger);
    }
  }

  /**
   * Destroys the sandbox, then removes the thread's history and record. The
   * history is removed again after the record, in case a message admitted
   * just before the deletion began was recorded meanwhile.
   */
  async #delete(
    thread: ThreadRecord,
    sandboxId: string | undefined,
    logger: Logger,
  ): Promise<void> {
    if (sandboxId !== undefined) {
      try {
        await this.#withLease(thread, logger, () =>
          this.#callProvider("destroy the sandbox", logger, () =>
            this.#options.sandboxProvider.destroy(sandboxId),
          ),
        );
      } catch (error) {
        await this.#settleAfterFailure(
          thread,
          sandboxId,
          describeProviderFailure("This thread could not be deleted", error),
          error,
          logger,
        );
        return;
      }
    }
    const { threadStore, threadEventLog, threadRuns } = this.#options;
    await threadEventLog.deleteHistory(thread.threadId);
    if (!(await threadStore.remove(thread.threadId, thread.version))) {
      logger.warn("The thread's record moved on while it was being deleted; leaving it as it is");
      return;
    }
    await threadEventLog.deleteHistory(thread.threadId);
    threadRuns.disconnectEveryone(thread.threadId);
    logger.info({ sandboxId }, "Deleted the thread, its sandbox and its history");
  }

  /**
   * After a provider operation failed, records the state the provider now
   * reports, with `problem` for the user, so the thread is never left in an
   * operation that is no longer under way. A sandbox the provider has lost
   * is recorded gone, and one whose state cannot be learned as failed.
   */
  async #settleAfterFailure(
    thread: ThreadRecord,
    sandboxId: string,
    problem: string,
    error: unknown,
    logger: Logger,
  ): Promise<void> {
    logger.error({ err: error, sandboxId, sandboxState: thread.sandbox.state }, problem);
    if (thread.sandbox.state === "deleting" && error instanceof SandboxNotFoundError) {
      await this.#delete(thread, undefined, logger);
      return;
    }
    const to = await this.#describeAfterFailure(sandboxId, problem, error, logger);
    const openRun =
      to.state === "running" ? undefined : await this.#readOpenRun(thread.threadId, logger);
    const recorded = await this.#record(thread, logger, to);
    if (recorded.kind === "changed") {
      await this.#closeOpenRun(thread.threadId, openRun, runEndedBySandboxStoppingMessage, logger);
    }
  }

  async #describeAfterFailure(
    sandboxId: string,
    problem: string,
    error: unknown,
    logger: Logger,
  ): Promise<ThreadSandboxRecord> {
    if (error instanceof SandboxNotFoundError) {
      return { state: "failed", sandboxId: undefined, reason: sandboxLostReason };
    }
    try {
      const status = await this.#options.sandboxProvider.getStatus(sandboxId);
      switch (status.state) {
        case "running":
          return { state: "running", sandboxId, problem: `${problem} It is still running.` };
        case "stopped":
          return { state: "stopped", sandboxId, problem: `${problem} It is stopped.` };
        case "missing":
          return { state: "failed", sandboxId: undefined, reason: sandboxLostReason };
        case "failed":
          return {
            state: "failed",
            sandboxId,
            reason: `${problem} The provider reports: ${status.reason}`,
          };
        default:
          return { state: "failed", sandboxId, reason: `${problem} Try again in a moment.` };
      }
    } catch (statusError) {
      logger.error({ err: statusError, sandboxId }, "Could not read the sandbox's state either");
      return { state: "failed", sandboxId, reason: `${problem} Try again later.` };
    }
  }

  /**
   * If the agent, already asked to stop, is in the middle of a run, waits a
   * little for the run to end, so that it ends as the agent tells it.
   * Reading fails only if the database does, and then the stop goes ahead.
   */
  async #waitForInterruptedRun(threadId: string, logger: Logger): Promise<void> {
    const { threadEventLog, timing } = this.#options;
    try {
      if (!(await threadEventLog.readAgentWork(threadId)).hasOpenRun) {
        return;
      }
      const deadline = Date.now() + timing.interruptGracePeriodInMilliseconds;
      while (Date.now() < deadline) {
        await sleep(interruptCheckIntervalInMilliseconds);
        if (!(await threadEventLog.readAgentWork(threadId)).hasOpenRun) {
          logger.info("The agent ended its run when interrupted");
          return;
        }
      }
      logger.warn("The agent did not end its run in time; stopping its sandbox anyway");
    } catch (error) {
      logger.error(
        { err: error },
        "Could not interrupt the agent before stopping; stopping anyway",
      );
    }
  }

  /**
   * The run open in the thread's history, or undefined if none is or it
   * cannot be read; one left open is closed when a supervisor next attaches.
   */
  async #readOpenRun(threadId: string, logger: Logger): Promise<OpenRun | undefined> {
    try {
      return await this.#options.threadEventLog.readOpenRun(threadId);
    } catch (error) {
      logger.error({ err: error }, "Could not read whether the stopped sandbox left a run open");
      return undefined;
    }
  }

  async #closeOpenRun(
    threadId: string,
    run: OpenRun | undefined,
    errorMessage: string,
    logger: Logger,
  ): Promise<void> {
    if (run === undefined) {
      return;
    }
    try {
      await this.#options.threadRuns.closeOpenRun(threadId, run, errorMessage);
    } catch (error) {
      logger.error(
        { err: error },
        "Could not close the run its stopped sandbox left open; it is closed when a supervisor next connects",
      );
    }
  }

  /** Records the outcome of an operation, from the version it was handed. */
  #record(
    thread: ThreadRecord,
    logger: Logger,
    to: ThreadSandboxRecord,
  ): Promise<TransitionOutcome> {
    return this.#recordTransition(
      { threadId: thread.threadId, fromVersion: thread.version, to, at: this.#options.clock() },
      logger,
    );
  }

  async #recordTransition(
    transition: Parameters<ThreadStore["transition"]>[0],
    logger: Logger,
  ): Promise<TransitionOutcome> {
    const outcome = await this.#options.threadStore.transition(transition);
    if (outcome.kind === "conflict") {
      logger.warn(
        { sandboxState: transition.to.state },
        "Did not record the operation's outcome: another control plane took it over, or the thread moved on",
      );
    }
    return outcome;
  }

  /**
   * Renews the operation's lease while `work` runs. A renewal that finds the
   * thread moved on means the operation was taken over; the work carries
   * on, since stopping a provider call part way helps nobody, and its
   * outcome is then not recorded.
   */
  async #withLease<Result>(
    thread: ThreadRecord,
    logger: Logger,
    work: () => Promise<Result>,
  ): Promise<Result> {
    const renew = () => {
      this.#options.threadStore
        .renewLease(thread.threadId, thread.version, this.leaseExpiry())
        .then((isRenewed) => {
          if (!isRenewed) {
            logger.warn("Lost the lease on a sandbox operation still under way");
          }
        })
        .catch((error: unknown) => logger.error({ err: error }, "Could not renew a lease"));
    };
    const timer = setInterval(renew, this.#options.timing.leaseRenewalIntervalInMilliseconds);
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  /** Calls the provider, trying again after pauses while it is unavailable. */
  async #callProvider<Result>(
    attempt: string,
    logger: Logger,
    call: () => Promise<Result>,
  ): Promise<Result> {
    const delays = this.#options.timing.providerRetryDelaysInMilliseconds;
    for (let attemptIndex = 0; ; attemptIndex += 1) {
      try {
        return await call();
      } catch (error) {
        const delay = delays[attemptIndex];
        if (!(error instanceof SandboxProviderUnavailableError) || delay === undefined) {
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

  #loggerFor(thread: ThreadRecord): Logger {
    return this.#options.logger.child({ threadId: thread.threadId });
  }
}

type SandboxRequestOutcome = {
  sandboxId: string;
  /**
   * The sandbox already existed when asked for: an earlier attempt, or a
   * request of this one that seemed to fail, made it, with a token the
   * thread already accepts.
   */
  wasMadeEarlier: boolean;
};

export function sandboxIdOf(sandbox: ThreadSandboxRecord): string | undefined {
  return "sandboxId" in sandbox ? sandbox.sandboxId : undefined;
}
