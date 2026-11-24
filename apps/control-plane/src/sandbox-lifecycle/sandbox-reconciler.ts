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
  limitLength,
  runEndedBySandboxStoppingMessage,
  sandboxLostReason,
} from "./lifecycle-messages.js";
import type { Clock } from "./lifecycle-settings.js";
import { type SandboxOperations, sandboxIdOf } from "./sandbox-operations.js";
import type { ThreadRuns } from "./thread-runs.js";

export type SandboxReconcilerOptions = {
  threadStore: ThreadStore;
  sandboxProvider: SandboxProvider;
  operations: SandboxOperations;
  threadEventLog: ThreadEventLog;
  threadRuns: ThreadRuns;
  clock: Clock;
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
      await this.#compareWithProvider(thread);
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

  async #compareWithProvider(thread: ThreadRecord): Promise<void> {
    const sandboxId = sandboxIdOf(thread.sandbox);
    if (sandboxId === undefined) {
      return;
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
      return;
    }
    const repair = decideRepair(thread.sandbox, status);
    if (repair === undefined) {
      return;
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
      return;
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
 * - Recorded running: stopped → stopped; failed → failed, resumable;
 *   missing → failed and gone.
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
        return { state: "stopped", sandboxId, problem: undefined };
      case "failed":
        return {
          state: "failed",
          sandboxId,
          reason: limitLength(
            `Its sandbox stopped by itself: ${status.reason}. Resume the thread to start it again.`,
          ),
        };
      default:
        return undefined;
    }
  }
  const isSettledElsewhere = recorded.state === "stopped" || recorded.state === "failed";
  return isSettledElsewhere && status.state === "running"
    ? { state: "running", sandboxId, problem: undefined }
    : undefined;
}
