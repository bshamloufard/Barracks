import { setTimeout as sleep } from "node:timers/promises";
import {
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
  type SandboxProvider,
  SandboxProviderUnavailableError,
  type SandboxStatus,
} from "@barrack/sandbox-providers";
import type { Logger } from "../logger.js";
import type { OpenRun, ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import {
  buildSupervisorEnvironment,
  type SupervisorEnvironmentSettings,
} from "../threads/supervisor-environment.js";
import { type MintedSupervisorToken, mintSupervisorToken } from "../threads/supervisor-token.js";
import {
  isOperatingState,
  type ThreadRecord,
  type ThreadSandboxRecord,
  type ThreadStore,
  type TransitionOutcome,
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
 * stuck in one under way. An operation that finds it has lost its lease
 * gives up where it is: it tries the provider no more, records nothing,
 * removes no history, and destroys no sandbox another control plane may
 * have adopted.
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
    this.#runInBackground(thread, logger, this.#perform(thread, supervisorToken, logger));
  }

  /**
   * Stops a sandbox, as `carryOut` does a thread just moved to `stopping`,
   * but records its thread `failed` with `reason` once it has stopped,
   * rather than `stopped`: for a sandbox stopped because something is wrong
   * with it, which the user must be told and which a message should not
   * simply wake. A stop taken over by another control plane finishes as an
   * ordinary one, without the reason.
   */
  stopAndFail(thread: ThreadRecord, reason: string): void {
    const logger = this.#loggerFor(thread);
    if (thread.sandbox.state !== "stopping") {
      logger.error({ sandboxState: thread.sandbox.state }, "Only a stopping sandbox can be failed");
      return;
    }
    const { sandboxId } = thread.sandbox;
    this.#runInBackground(thread, logger, this.#stop(thread, sandboxId, logger, reason));
  }

  #runInBackground(thread: ThreadRecord, logger: Logger, work: Promise<void>): void {
    const operation = work.catch((error: unknown) => {
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
   * already made is handed this attempt's token before it is started, since
   * the attempt that made it may have been cut short before handing its own
   * over; a supervisor already running keeps the one it read, and every
   * token minted for the creation is still accepted.
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
    let made: SandboxRequestOutcome | undefined;
    try {
      outcome = await this.#withLease(thread, logger, async (lease) => {
        made = await this.#requestSandbox(thread.threadId, token.token, isTakenOver, lease, logger);
        return made;
      });
    } catch (error) {
      if (error instanceof LeaseLostError) {
        if (made !== undefined) {
          await this.#removeUnrecordedSandbox(thread.threadId, made, logger);
        }
        return;
      }
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
    lease: Lease,
    logger: Logger,
  ): Promise<SandboxRequestOutcome> {
    const { supervisorEnvironment, supervisorSecrets } = buildSupervisorEnvironment(
      this.#options.supervisorEnvironment,
      threadId,
      supervisorToken,
    );
    let attemptCount = 0;
    try {
      return await this.#callProvider("create the sandbox", lease, logger, async () => {
        attemptCount += 1;
        const { sandboxId } = await this.#options.sandboxProvider.create({
          threadId,
          supervisorEnvironment,
          supervisorSecrets,
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
        "An earlier attempt created the thread's sandbox; making sure it runs, with this attempt's token",
      );
      // The attempt that made it may have been cut short before it handed
      // its token over, so this attempt's is handed over again; the thread
      // accepts both.
      await this.#callProvider("start the sandbox", lease, logger, () =>
        this.#options.sandboxProvider.start(sandboxId, { replacementSecrets: supervisorSecrets }),
      );
      return { sandboxId, wasMadeEarlier: true };
    }
  }

  /**
   * The creation was taken over. A sandbox this attempt made would run
   * unrecorded if nobody else takes it, so it is destroyed, but only when
   * that is certain: the thread is gone, or settled without naming it. While
   * another control plane holds the creation (the record is still
   * `creating`), the sandbox is left, since that one will find and adopt
   * it; and one an earlier attempt made is never this attempt's to destroy.
   */
  async #removeUnrecordedSandbox(
    threadId: string,
    outcome: SandboxRequestOutcome,
    logger: Logger,
  ): Promise<void> {
    if (outcome.wasMadeEarlier) {
      return;
    }
    const current = await this.#options.threadStore.find(threadId);
    const isSolelyThisAttempts =
      current === undefined ||
      (!isOperatingState(current.sandbox.state) &&
        sandboxIdOf(current.sandbox) !== outcome.sandboxId);
    if (!isSolelyThisAttempts) {
      logger.warn(
        { sandboxId: outcome.sandboxId },
        "Another control plane took over this creation; leaving it the sandbox made",
      );
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
      await this.#withLease(thread, logger, (lease) =>
        this.#callProvider("start the sandbox", lease, logger, () =>
          this.#options.sandboxProvider.start(sandboxId),
        ),
      );
    } catch (error) {
      if (error instanceof LeaseLostError) {
        return;
      }
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
  async #stop(
    thread: ThreadRecord,
    sandboxId: string,
    logger: Logger,
    failureReason?: string,
  ): Promise<void> {
    const { threadRuns } = this.#options;
    threadRuns.prepareForStop(thread.threadId);
    try {
      await this.#waitForInterruptedRun(thread.threadId, logger);
      await this.#withLease(thread, logger, (lease) =>
        this.#callProvider("stop the sandbox", lease, logger, () =>
          this.#options.sandboxProvider.stop(sandboxId),
        ),
      );
    } catch (error) {
      if (error instanceof LeaseLostError) {
        return;
      }
      if (!(await this.#hasStoppedAfterAll(sandboxId, error, logger))) {
        await this.#settleAfterFailure(
          thread,
          sandboxId,
          describeProviderFailure("Its sandbox could not be stopped", error),
          error,
          logger,
        );
        return;
      }
    } finally {
      threadRuns.finishStop(thread.threadId);
    }
    const openRun = await this.#readOpenRun(thread.threadId, logger);
    if (failureReason !== undefined) {
      await this.#recordStoppedAsFailed(thread, sandboxId, failureReason, openRun, logger);
      return;
    }
    const finished = await this.#options.threadStore.finishStopping({
      threadId: thread.threadId,
      fromVersion: thread.version,
      wakeLeaseExpiresAt: this.leaseExpiry(),
      at: this.#options.clock(),
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

  async #recordStoppedAsFailed(
    thread: ThreadRecord,
    sandboxId: string,
    reason: string,
    openRun: OpenRun | undefined,
    logger: Logger,
  ): Promise<void> {
    const recorded = await this.#record(thread, logger, { state: "failed", sandboxId, reason });
    if (recorded.kind !== "changed") {
      return;
    }
    await this.#closeOpenRun(thread.threadId, openRun, runEndedBySandboxStoppingMessage, logger);
    logger.warn({ sandboxId, reason }, "Stopped the thread's sandbox and recorded it failed");
  }

  /**
   * A stop can report failing and yet have stopped the sandbox (its answer
   * lost on the way back, say). It then did what was asked, and finishes as
   * a stop that succeeded, so a message that asked the sandbox to wake
   * meanwhile still wakes it, rather than waiting for an agent nobody
   * starts. If the state cannot be read, the failure is settled as any
   * other, which reads it again and records why it could not.
   */
  async #hasStoppedAfterAll(sandboxId: string, error: unknown, logger: Logger): Promise<boolean> {
    if (error instanceof SandboxNotFoundError) {
      return false;
    }
    let status: SandboxStatus;
    try {
      status = await this.#options.sandboxProvider.getStatus(sandboxId);
    } catch {
      return false;
    }
    if (status.state !== "stopped") {
      return false;
    }
    logger.warn(
      { err: error, sandboxId },
      "Stopping the sandbox reported a failure, but the sandbox is stopped; finishing the stop",
    );
    return true;
  }

  /**
   * Destroys the sandbox, then removes the thread's history and record. The
   * history is removed again after the record, behind anything the relay
   * was still recording, in case a message admitted just before the
   * deletion began is recorded meanwhile.
   */
  async #delete(
    thread: ThreadRecord,
    sandboxId: string | undefined,
    logger: Logger,
  ): Promise<void> {
    this.#options.threadRuns.prepareForDeletion(thread.threadId);
    if (sandboxId !== undefined) {
      try {
        await this.#withLease(thread, logger, (lease) =>
          this.#callProvider("destroy the sandbox", lease, logger, () =>
            this.#options.sandboxProvider.destroy(sandboxId),
          ),
        );
      } catch (error) {
        if (error instanceof LeaseLostError) {
          return;
        }
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
    // A deletion taken over meanwhile is the taker's to finish; a destroy
    // that failed there may have left the thread with its history.
    if (!(await threadStore.renewLease(thread.threadId, thread.version, this.leaseExpiry()))) {
      logger.warn("Lost the lease on a deletion; leaving the thread's history to whoever holds it");
      return;
    }
    await threadEventLog.deleteHistory(thread.threadId);
    if (!(await threadStore.remove(thread.threadId, thread.version))) {
      logger.warn("The thread's record moved on while it was being deleted; leaving it as it is");
      return;
    }
    await threadRuns.forgetDeletedThread(thread.threadId);
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
   * Renews the operation's lease while `work` runs, and checks it once more
   * when the work ends. A renewal that finds the thread moved on means the
   * operation was taken over: the provider call under way is let finish,
   * since stopping one part way helps nobody, but `work` is told (through
   * `lease`) to try nothing more, and this throws `LeaseLostError` however
   * the work ended, so its caller records nothing and undoes nothing it is
   * not certain is its own.
   */
  async #withLease<Result>(
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
          this.leaseExpiry(),
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
  async #callProvider<Result>(
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

  #loggerFor(thread: ThreadRecord): Logger {
    return this.#options.logger.child({ threadId: thread.threadId });
  }
}

/** Whether the operation's lease has been found lost, so it should try nothing more. */
type Lease = { isLost: () => boolean };

/** The operation's lease was taken by another control plane: it gives up, recording nothing. */
class LeaseLostError extends Error {
  constructor() {
    super("Another control plane took over this sandbox operation.");
    this.name = "LeaseLostError";
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
