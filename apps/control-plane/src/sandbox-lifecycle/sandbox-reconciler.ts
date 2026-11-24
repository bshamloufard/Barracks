import type { SandboxProvider, SandboxStatus } from "@barrack/sandbox-providers";
import type { Logger } from "../logger.js";
import type { OpenRun, ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import {
  operatingStates,
  type SandboxState,
  type ThreadRecord,
  type ThreadSandboxRecord,
  type ThreadStore,
} from "../threads/thread-store.js";
import {
  describeSandboxFailure,
  describeSupervisorNeverAttached,
  runEndedBySandboxStoppingMessage,
  sandboxLostReason,
  stoppedFromOutsideProblem,
} from "./lifecycle-messages.js";
import type { Clock, LifecycleTiming } from "./lifecycle-settings.js";
import { sandboxIdOf } from "./operation-outcomes.js";
import type { SandboxOperations } from "./sandbox-operations.js";
import type { ThreadRuns } from "./thread-runs.js";

export type SandboxReconcilerOptions = {
  threadStore: ThreadStore;
  sandboxProvider: SandboxProvider;
  operations: SandboxOperations;
  threadEventLog: ThreadEventLog;
  threadRuns: ThreadRuns;
  clock: Clock;
  timing: LifecycleTiming;
  /** The address sandboxes are told to reach the control plane at, named when they cannot. */
  controlPlaneUrlForSandboxes: string;
  logger: Logger;
};

/** More than any installation this serves has; the rest wait for the next sweep. */
const threadsPerSweep = 1_000;

/**
 * Brings what the control plane believes about sandboxes back in line with
 * what is true, at startup and then periodically:
 *
 * - **An operation whose control plane has gone** (its lease expired
 *   unrenewed: the control plane was killed, or redeployed with no grace)
 *   is taken over and carried on from its provider step, which is safe to
 *   repeat. A control plane still at work renews its lease, so another
 *   instance, during a redeploy's overlap say, never takes over a creation
 *   or stop that is merely slow. This replaces failing every thread still
 *   creating at startup, which failed those the old instance was still
 *   creating.
 * - **A settled sandbox the provider reports otherwise** is recorded as the
 *   provider reports it (see `decideRepair`), and a run it left open is
 *   closed in history. Running sandboxes are checked every sweep, since a
 *   running sandbox costs money and can stop by itself; stopped and failed
 *   ones only at startup, since nothing but the control plane starts them.
 * - **A running sandbox whose supervisor never attached** within
 *   `supervisorAttachmentDeadlineInMilliseconds` of its sandbox running is
 *   stopped, and its thread failed with the likely causes, since it can do
 *   nothing and costs money; otherwise its thread would show as starting
 *   for ever, with no clue why.
 */
export class SandboxReconciler {
  readonly #options: SandboxReconcilerOptions;

  constructor(options: SandboxReconcilerOptions) {
    this.#options = options;
  }

  async reconcile(scope: { includeSettledSandboxes: boolean }): Promise<void> {
    await this.#takeOverAbandonedOperations();
    const states: SandboxState[] = scope.includeSettledSandboxes
      ? ["running", "stopped", "failed"]
      : ["running"];
    for (const thread of await this.#options.threadStore.listInStates(states, threadsPerSweep)) {
      const isRepaired = await this.#compareWithProvider(thread);
      if (!isRepaired) {
        await this.#failIfSupervisorNeverAttached(thread);
      }
    }
  }

  /**
   * Moved to `stopping` from the version read, so a supervisor attaching
   * meanwhile, which does not move the version, still loses the race only
   * by moments, and two control planes never both stop it.
   *
   * A thread whose supervisor is attached here is never failed for it: the
   * note that it attached was lost (a failed write), and is made again
   * instead, every sweep until it holds. Only the control plane the
   * supervisor is attached to can know, so during a redeploy's overlap the
   * other one relies on this one making the note before the deadline.
   */
  async #failIfSupervisorNeverAttached(thread: ThreadRecord): Promise<void> {
    const { sandbox, awaitingSupervisorSince } = thread;
    const { clock, timing, operations, threadStore, logger } = this.#options;
    if (sandbox.state !== "running" || awaitingSupervisorSince === undefined) {
      return;
    }
    if (this.#options.threadRuns.isSupervisorAttached(thread.threadId)) {
      await this.#recordSupervisorAttachedAgain(thread.threadId);
      return;
    }
    const deadline = timing.supervisorAttachmentDeadlineInMilliseconds;
    if (clock().getTime() - awaitingSupervisorSince.getTime() < deadline) {
      return;
    }
    const outcome = await threadStore.transition({
      threadId: thread.threadId,
      fromVersion: thread.version,
      to: {
        state: "stopping",
        sandboxId: sandbox.sandboxId,
        leaseExpiresAt: operations.leaseExpiry(),
      },
      at: clock(),
    });
    if (outcome.kind !== "changed") {
      return;
    }
    const reason = describeSupervisorNeverAttached(
      deadline,
      this.#options.controlPlaneUrlForSandboxes,
    );
    logger.warn(
      {
        threadId: thread.threadId,
        sandboxId: sandbox.sandboxId,
        controlPlaneUrlForSandboxes: this.#options.controlPlaneUrlForSandboxes,
      },
      "A sandbox ran without its supervisor ever connecting; stopping it. Check that sandboxes can reach BARRACK_SANDBOX_CONTROL_PLANE_URL, and the sandbox's own log",
    );
    operations.stopAndFail(outcome.thread, reason);
  }

  async #recordSupervisorAttachedAgain(threadId: string): Promise<void> {
    const { threadStore, logger } = this.#options;
    logger.warn(
      { threadId },
      "A thread's supervisor is attached but its sandbox is recorded as awaiting one; recording it attached again",
    );
    try {
      await threadStore.recordSupervisorAttached(threadId);
    } catch (error) {
      logger.error(
        { err: error, threadId },
        "Could not record that a supervisor attached; the next check tries again",
      );
    }
  }

  async #takeOverAbandonedOperations(): Promise<void> {
    const { threadStore, operations, clock } = this.#options;
    const now = clock().getTime();
    for (const thread of await threadStore.listInStates(operatingStates, threadsPerSweep)) {
      const { sandbox } = thread;
      if (!("leaseExpiresAt" in sandbox) || sandbox.leaseExpiresAt.getTime() > now) {
        continue;
      }
      const outcome = await threadStore.transition({
        threadId: thread.threadId,
        fromVersion: thread.version,
        to: { ...sandbox, leaseExpiresAt: operations.leaseExpiry() },
        at: clock(),
      });
      if (outcome.kind === "changed") {
        this.#options.logger.warn(
          { threadId: thread.threadId, sandboxState: sandbox.state },
          "Taking over a sandbox operation whose control plane stopped renewing its lease",
        );
        operations.carryOut(outcome.thread);
      }
    }
  }

  /** Whether the thread was found otherwise at the provider, and recorded so. */
  async #compareWithProvider(thread: ThreadRecord): Promise<boolean> {
    const sandboxId = sandboxIdOf(thread.sandbox);
    if (sandboxId === undefined) {
      return false;
    }
    const logger = this.#options.logger.child({ threadId: thread.threadId, sandboxId });
    let status: SandboxStatus;
    try {
      status = await this.#options.sandboxProvider.getStatus(sandboxId);
    } catch (error) {
      logger.warn(
        { err: error },
        "Could not read a sandbox's state to reconcile it; trying again later",
      );
      return true;
    }
    const repair = decideRepair(thread.sandbox, status);
    if (repair === undefined) {
      return false;
    }
    const openRun =
      thread.sandbox.state === "running"
        ? await this.#readOpenRun(thread.threadId, logger)
        : undefined;
    const outcome = await this.#options.threadStore.transition({
      threadId: thread.threadId,
      fromVersion: thread.version,
      to: repair,
      at: this.#options.clock(),
    });
    if (outcome.kind !== "changed") {
      return true;
    }
    logger.warn(
      {
        recordedState: thread.sandbox.state,
        providerState: status.state,
        nowRecorded: repair.state,
      },
      "The provider reported a sandbox in another state than recorded; recorded what it reports",
    );
    if (openRun !== undefined) {
      await this.#closeOpenRun(thread.threadId, openRun, logger);
    }
    return true;
  }

  /**
   * Read before the repair is recorded at the version the thread was read
   * at, so it is the run the stopped sandbox left, never one opened after a
   * wake that followed the repair.
   */
  async #readOpenRun(threadId: string, logger: Logger): Promise<OpenRun | undefined> {
    try {
      return await this.#options.threadEventLog.readOpenRun(threadId);
    } catch (error) {
      logger.warn({ err: error }, "Could not read whether a stopped sandbox left a run open");
      return undefined;
    }
  }

  async #closeOpenRun(threadId: string, run: OpenRun, logger: Logger): Promise<void> {
    try {
      await this.#options.threadRuns.closeOpenRun(threadId, run, runEndedBySandboxStoppingMessage);
    } catch (error) {
      logger.error({ err: error }, "Could not close the run a stopped sandbox left open");
    }
  }
}

/**
 * What to record when the provider reports a settled sandbox in another
 * state, or undefined to leave it. A sandbox that is starting or stopping
 * at the provider is left until it settles.
 *
 * - Recorded running: stopped → stopped, saying something else stopped it;
 *   failed → failed, resumable, saying why and what to do; missing → failed
 *   and gone.
 * - Recorded stopped, or failed with a sandbox: running → running (whatever
 *   started it, it costs money, and idle shutdown stops it once it is idle);
 *   missing → failed and gone. Stopped and failed are left as recorded.
 */
export function decideRepair(
  recorded: ThreadSandboxRecord,
  status: SandboxStatus,
): ThreadSandboxRecord | undefined {
  const sandboxId = sandboxIdOf(recorded);
  if (sandboxId === undefined) {
    return undefined;
  }
  if (status.state === "missing") {
    return { state: "failed", sandboxId: undefined, reason: sandboxLostReason };
  }
  if (recorded.state === "running") {
    switch (status.state) {
      case "stopped":
        return { state: "stopped", sandboxId, problem: stoppedFromOutsideProblem };
      case "failed":
        return { state: "failed", sandboxId, reason: describeSandboxFailure(status) };
      default:
        return undefined;
    }
  }
  const isSettledElsewhere = recorded.state === "stopped" || recorded.state === "failed";
  return isSettledElsewhere && status.state === "running"
    ? { state: "running", sandboxId, problem: undefined }
    : undefined;
}
