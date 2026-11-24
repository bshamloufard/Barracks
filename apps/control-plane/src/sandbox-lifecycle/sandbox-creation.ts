import { SandboxAlreadyExistsError, type SandboxProvider } from "@barrack/sandbox-providers";
import type { Logger } from "../logger.js";
import {
  buildSupervisorEnvironment,
  type SupervisorEnvironmentSettings,
} from "../threads/supervisor-environment.js";
import { type MintedSupervisorToken, mintSupervisorToken } from "../threads/supervisor-token.js";
import { isOperatingState, type ThreadRecord, type ThreadStore } from "../threads/thread-store.js";
import { describeProviderFailure } from "./lifecycle-messages.js";
import type { Clock } from "./lifecycle-settings.js";
import { type Lease, LeaseLostError, type OperationLeases } from "./operation-lease.js";
import { type OperationOutcomes, sandboxIdOf } from "./operation-outcomes.js";

/*
 * Creating a thread's sandbox, for a thread recorded `creating`: by the
 * request that recorded it, or by reconciliation taking over a creation
 * whose control plane has gone. Either may find a sandbox an earlier
 * attempt made, which it adopts; one that loses the creation to another
 * control plane destroys the sandbox it made only when nobody else can
 * adopt it.
 */

export type SandboxCreationOptions = {
  threadStore: ThreadStore;
  sandboxProvider: SandboxProvider;
  supervisorEnvironment: SupervisorEnvironmentSettings;
  clock: Clock;
  leases: OperationLeases;
  outcomes: OperationOutcomes;
};

type SandboxRequestOutcome = {
  sandboxId: string;
  /**
   * The sandbox already existed when asked for: an earlier attempt, or a
   * request of this one that seemed to fail, made it, with a token the
   * thread already accepts.
   */
  wasMadeEarlier: boolean;
};

export class SandboxCreation {
  readonly #options: SandboxCreationOptions;

  constructor(options: SandboxCreationOptions) {
    this.#options = options;
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
  async create(
    handedOver: ThreadRecord,
    givenToken: MintedSupervisorToken | undefined,
    logger: Logger,
  ): Promise<void> {
    const { leases, outcomes } = this.#options;
    const isTakenOver = givenToken === undefined;
    const token = givenToken ?? mintSupervisorToken();
    const thread = isTakenOver ? await this.#recordNewToken(handedOver, token, logger) : handedOver;
    if (thread === undefined) {
      return;
    }
    let outcome: SandboxRequestOutcome;
    let made: SandboxRequestOutcome | undefined;
    try {
      outcome = await leases.hold(thread, logger, async (lease) => {
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
      await outcomes.record(thread, logger, {
        state: "failed",
        sandboxId: undefined,
        reason: `${describeProviderFailure("Its sandbox could not be created", error)} Delete this thread and create a new one to try again.`,
      });
      return;
    }
    const recorded = await outcomes.record(thread, logger, {
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
    const outcome = await this.#options.outcomes.recordTransition(
      {
        threadId: thread.threadId,
        fromVersion: thread.version,
        to: { state: "creating", leaseExpiresAt: this.#options.leases.expiry() },
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
    const { leases, sandboxProvider } = this.#options;
    const { supervisorEnvironment, supervisorSecrets } = buildSupervisorEnvironment(
      this.#options.supervisorEnvironment,
      threadId,
      supervisorToken,
    );
    let attemptCount = 0;
    try {
      return await leases.callProvider("create the sandbox", lease, logger, async () => {
        attemptCount += 1;
        const { sandboxId } = await sandboxProvider.create({
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
      await leases.callProvider("start the sandbox", lease, logger, () =>
        sandboxProvider.start(sandboxId, { replacementSecrets: supervisorSecrets }),
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
}
