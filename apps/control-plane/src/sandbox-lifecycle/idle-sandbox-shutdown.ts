import type { Logger } from "../logger.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type { ThreadRecord, ThreadStore } from "../threads/thread-store.js";
import type { Clock } from "./lifecycle-settings.js";
import type { SandboxOperations } from "./sandbox-operations.js";

export type IdleSandboxShutdownOptions = {
  threadStore: ThreadStore;
  threadEventLog: ThreadEventLog;
  operations: SandboxOperations;
  idlePeriodInMilliseconds: number;
  clock: Clock;
  logger: Logger;
};

/** Plenty per sweep; any more are stopped on the next. */
const sandboxesPerSweep = 100;

/**
 * Stops sandboxes nobody is using, because an idle computer billed by the
 * hour is the fastest way to burn a small budget. The control plane decides,
 * not the provider: Daytona's own auto-stop counts only interaction from
 * outside and would stop an agent working quietly inside.
 *
 * A sandbox is idle when, for the whole idle period, nothing happened in its
 * thread (no user message, no agent event; see `SandboxLifecycle`), and
 * right now its agent has no run open and no user message waits to be
 * delivered. A run that is open is never cut short, however quiet: a long
 * build prints nothing for minutes. A client merely watching does not count,
 * since a forgotten tab would otherwise keep a sandbox billing for ever, and
 * watching needs only the control plane, which holds the history.
 *
 * The stop is made only if the thread is still as it was read, activity
 * included, so a message arriving in between keeps the sandbox running. The
 * decision lives entirely in the database, so it survives a restart, and of
 * two control planes deciding at once only one stops the sandbox.
 */
export class IdleSandboxShutdown {
  readonly #options: IdleSandboxShutdownOptions;

  constructor(options: IdleSandboxShutdownOptions) {
    this.#options = options;
  }

  async stopIdleSandboxes(): Promise<void> {
    const { threadStore, clock, idlePeriodInMilliseconds } = this.#options;
    const cutoff = new Date(clock().getTime() - idlePeriodInMilliseconds);
    for (const thread of await threadStore.listRunningInactiveSince(cutoff, sandboxesPerSweep)) {
      await this.#stopIfIdle(thread);
    }
  }

  async #stopIfIdle(thread: ThreadRecord): Promise<void> {
    const { threadStore, threadEventLog, operations, clock, logger } = this.#options;
    if (thread.sandbox.state !== "running") {
      return;
    }
    const work = await threadEventLog.readAgentWork(thread.threadId);
    if (work.hasOpenRun || work.hasUndeliveredUserMessage) {
      return;
    }
    const outcome = await threadStore.transition({
      threadId: thread.threadId,
      fromVersion: thread.version,
      to: {
        state: "stopping",
        sandboxId: thread.sandbox.sandboxId,
        leaseExpiresAt: operations.leaseExpiry(),
      },
      at: clock(),
      onlyIfLastActiveAt: thread.lastActivityAt,
    });
    if (outcome.kind !== "changed") {
      return;
    }
    logger.info(
      { threadId: thread.threadId, lastActivityAt: thread.lastActivityAt.toISOString() },
      "Stopping a sandbox that has been idle for the idle period",
    );
    operations.carryOut(outcome.thread);
  }
}
