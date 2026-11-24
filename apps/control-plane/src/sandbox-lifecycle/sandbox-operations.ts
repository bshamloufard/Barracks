import { setTimeout as sleep } from "node:timers/promises";
import {
  SandboxNotFoundError,
  type SandboxProvider,
  type SandboxStatus,
} from "@barrack/sandbox-providers";
import type { Logger } from "../logger.js";
import type { OpenRun, ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type { SupervisorEnvironmentSettings } from "../threads/supervisor-environment.js";
import type { MintedSupervisorToken } from "../threads/supervisor-token.js";
import type { ThreadRecord, ThreadStore } from "../threads/thread-store.js";
import {
  describeProviderFailure,
  runEndedBySandboxStoppingMessage,
  runEndedByStopMessage,
} from "./lifecycle-messages.js";
import type { Clock, LifecycleTiming } from "./lifecycle-settings.js";
import { LeaseLostError, OperationLeases } from "./operation-lease.js";
import { OperationOutcomes } from "./operation-outcomes.js";
import { SandboxCreation } from "./sandbox-creation.js";
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
 * nothing. Creating has a file of its own (`SandboxCreation`); starting,
 * stopping and deleting are here.
 *
 * While the provider works, the operation's lease is renewed, so another
 * control plane does not take it over (`OperationLeases`). Every outcome is
 * recorded with the version the operation was handed, so one taken over or
 * overtaken records nothing; and a provider operation that fails leaves the
 * thread in the state the provider then reports, with a reason the user is
 * shown, never stuck in one under way (`OperationOutcomes`). An operation
 * that finds it has lost its lease gives up where it is: it tries the
 * provider no more, records nothing, removes no history, and destroys no
 * sandbox another control plane may have adopted.
 */
export class SandboxOperations {
  readonly #options: SandboxOperationsOptions;
  readonly #leases: OperationLeases;
  readonly #outcomes: OperationOutcomes;
  readonly #creation: SandboxCreation;
  readonly #operationsUnderWay = new Set<Promise<void>>();

  constructor(options: SandboxOperationsOptions) {
    this.#options = options;
    const { threadStore, threadEventLog, sandboxProvider, threadRuns, clock, timing } = options;
    this.#leases = new OperationLeases({ threadStore, clock, timing });
    this.#outcomes = new OperationOutcomes({
      threadStore,
      threadEventLog,
      sandboxProvider,
      threadRuns,
      clock,
    });
    this.#creation = new SandboxCreation({
      threadStore,
      sandboxProvider,
      supervisorEnvironment: options.supervisorEnvironment,
      clock,
      leases: this.#leases,
      outcomes: this.#outcomes,
    });
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
    return this.#leases.expiry();
  }

  async #perform(
    thread: ThreadRecord,
    supervisorToken: MintedSupervisorToken | undefined,
    logger: Logger,
  ): Promise<void> {
    const { sandbox } = thread;
    switch (sandbox.state) {
      case "creating":
        await this.#creation.create(thread, supervisorToken, logger);
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

  async #start(thread: ThreadRecord, sandboxId: string, logger: Logger): Promise<void> {
    try {
      await this.#leases.hold(thread, logger, (lease) =>
        this.#leases.callProvider("start the sandbox", lease, logger, () =>
          this.#options.sandboxProvider.start(sandboxId),
        ),
      );
    } catch (error) {
      if (error instanceof LeaseLostError) {
        return;
      }
      await this.#outcomes.settleAfterFailure(
        thread,
        sandboxId,
        describeProviderFailure("Its sandbox could not be started", error),
        error,
        logger,
      );
      return;
    }
    const recorded = await this.#outcomes.record(thread, logger, {
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
      await this.#leases.hold(thread, logger, (lease) =>
        this.#leases.callProvider("stop the sandbox", lease, logger, () =>
          this.#options.sandboxProvider.stop(sandboxId),
        ),
      );
    } catch (error) {
      if (error instanceof LeaseLostError) {
        return;
      }
      if (!(await this.#hasStoppedAfterAll(sandboxId, error, logger))) {
        await this.#outcomes.settleAfterFailure(
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
    const openRun = await this.#outcomes.readOpenRun(thread.threadId, logger);
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
    await this.#outcomes.closeOpenRun(thread.threadId, openRun, runEndedByStopMessage, logger);
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
    const recorded = await this.#outcomes.record(thread, logger, {
      state: "failed",
      sandboxId,
      reason,
    });
    if (recorded.kind !== "changed") {
      return;
    }
    await this.#outcomes.closeOpenRun(
      thread.threadId,
      openRun,
      runEndedBySandboxStoppingMessage,
      logger,
    );
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
   * Destroys the sandbox, then removes the thread's history and record. The
   * history is removed again after the record, behind anything the relay
   * was still recording, in case a message admitted just before the
   * deletion began is recorded meanwhile. A sandbox the provider no longer
   * has is as good as destroyed.
   */
  async #delete(
    thread: ThreadRecord,
    sandboxId: string | undefined,
    logger: Logger,
  ): Promise<void> {
    this.#options.threadRuns.prepareForDeletion(thread.threadId);
    if (sandboxId !== undefined) {
      try {
        await this.#leases.hold(thread, logger, (lease) =>
          this.#leases.callProvider("destroy the sandbox", lease, logger, () =>
            this.#options.sandboxProvider.destroy(sandboxId),
          ),
        );
      } catch (error) {
        if (error instanceof LeaseLostError) {
          return;
        }
        const problem = describeProviderFailure("This thread could not be deleted", error);
        if (error instanceof SandboxNotFoundError) {
          logger.error({ err: error, sandboxId, sandboxState: thread.sandbox.state }, problem);
          await this.#delete(thread, undefined, logger);
          return;
        }
        await this.#outcomes.settleAfterFailure(thread, sandboxId, problem, error, logger);
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

  #loggerFor(thread: ThreadRecord): Logger {
    return this.#options.logger.child({ threadId: thread.threadId });
  }
}
