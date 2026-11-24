import { SandboxNotFoundError, type SandboxProvider } from "@barrack/sandbox-providers";
import type { Logger } from "../logger.js";
import type { OpenRun, ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type {
  ThreadRecord,
  ThreadSandboxRecord,
  ThreadStore,
  TransitionOutcome,
} from "../threads/thread-store.js";
import { runEndedBySandboxStoppingMessage, sandboxLostReason } from "./lifecycle-messages.js";
import type { Clock } from "./lifecycle-settings.js";
import type { ThreadRuns } from "./thread-runs.js";

/*
 * Recording how a sandbox operation ended: always from the version of the
 * thread it was handed, so an operation taken over or overtaken records
 * nothing; after a provider failure, as the state the provider then
 * reports, so the thread is never left in an operation no longer under
 * way; and closing in history any run its sandbox's stopping left open.
 */

export type OperationOutcomesOptions = {
  threadStore: ThreadStore;
  threadEventLog: ThreadEventLog;
  sandboxProvider: SandboxProvider;
  threadRuns: ThreadRuns;
  clock: Clock;
};

export class OperationOutcomes {
  readonly #options: OperationOutcomesOptions;

  constructor(options: OperationOutcomesOptions) {
    this.#options = options;
  }

  /** Records the outcome of an operation, from the version it was handed. */
  record(
    thread: ThreadRecord,
    logger: Logger,
    to: ThreadSandboxRecord,
  ): Promise<TransitionOutcome> {
    return this.recordTransition(
      { threadId: thread.threadId, fromVersion: thread.version, to, at: this.#options.clock() },
      logger,
    );
  }

  async recordTransition(
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
   * After a provider operation failed, records the state the provider now
   * reports, with `problem` for the user, so the thread is never left in an
   * operation that is no longer under way. A sandbox the provider has lost
   * is recorded gone, and one whose state cannot be learned as failed.
   */
  async settleAfterFailure(
    thread: ThreadRecord,
    sandboxId: string,
    problem: string,
    error: unknown,
    logger: Logger,
  ): Promise<void> {
    logger.error({ err: error, sandboxId, sandboxState: thread.sandbox.state }, problem);
    const to = await this.#describeAfterFailure(sandboxId, problem, error, logger);
    const openRun =
      to.state === "running" ? undefined : await this.readOpenRun(thread.threadId, logger);
    const recorded = await this.record(thread, logger, to);
    if (recorded.kind === "changed") {
      await this.closeOpenRun(thread.threadId, openRun, runEndedBySandboxStoppingMessage, logger);
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
   * The run open in the thread's history, or undefined if none is or it
   * cannot be read; one left open is closed when a supervisor next attaches.
   */
  async readOpenRun(threadId: string, logger: Logger): Promise<OpenRun | undefined> {
    try {
      return await this.#options.threadEventLog.readOpenRun(threadId);
    } catch (error) {
      logger.error({ err: error }, "Could not read whether the stopped sandbox left a run open");
      return undefined;
    }
  }

  async closeOpenRun(
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
}

/** The sandbox a thread's record names, if it names one. */
export function sandboxIdOf(sandbox: ThreadSandboxRecord): string | undefined {
  return "sandboxId" in sandbox ? sandbox.sandboxId : undefined;
}
