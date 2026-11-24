import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { maximumErrorMessageLength } from "@barrack/protocol";
import {
  SandboxAlreadyExistsError,
  type SandboxProvider,
  SandboxProviderError,
  SandboxProviderUnavailableError,
} from "@barrack/sandbox-providers";
import type { Logger } from "../logger.js";
import {
  buildSupervisorEnvironment,
  type SupervisorEnvironmentSettings,
} from "./supervisor-environment.js";
import { mintSupervisorToken } from "./supervisor-token.js";
import type { ThreadRecord, ThreadStore } from "./thread-store.js";

/**
 * A provider that is unavailable may be back in a moment, so creation is
 * tried again after these pauses before the thread is marked failed.
 * Creation already runs after the user has been answered, so waiting costs
 * nothing but time.
 */
const defaultRetryDelaysInMilliseconds = [1_000, 5_000];

export type ThreadCreatorOptions = {
  threadStore: ThreadStore;
  sandboxProvider: SandboxProvider;
  /** Recorded with each thread, so a sandbox identifier is never read against the wrong provider. */
  sandboxProviderName: string;
  supervisorEnvironment: SupervisorEnvironmentSettings;
  logger: Logger;
  retryDelaysInMilliseconds?: readonly number[];
};

type SandboxRequestOutcome = { ok: true; sandboxId: string } | { ok: false; reason: string };

/**
 * Brings threads into existence. Creating a thread records it, with the
 * digest of a newly minted supervisor token, and returns at once; its
 * sandbox is then created through the provider in the background, because
 * a real provider can take minutes, and the record moves to `ready` or to
 * `failed` with a reason the user is shown.
 *
 * No sandbox is left behind unrecorded: if the record cannot be updated
 * after the provider created the sandbox, the sandbox is destroyed.
 */
export class ThreadCreator {
  readonly #options: ThreadCreatorOptions;
  readonly #retryDelaysInMilliseconds: readonly number[];
  readonly #sandboxCreationsInProgress = new Set<Promise<void>>();

  constructor(options: ThreadCreatorOptions) {
    this.#options = options;
    this.#retryDelaysInMilliseconds =
      options.retryDelaysInMilliseconds ?? defaultRetryDelaysInMilliseconds;
  }

  /** Records a new thread for its owner and starts creating its sandbox, without waiting for it. */
  async createThread(ownerUserId: string): Promise<ThreadRecord> {
    const { threadStore, sandboxProviderName } = this.#options;
    const threadId = randomUUID();
    const supervisorToken = mintSupervisorToken();
    const thread = await threadStore.create({
      threadId,
      ownerUserId,
      sandboxProvider: sandboxProviderName,
      supervisorTokenDigest: supervisorToken.digest,
    });
    const logger = this.#options.logger.child({ threadId });
    logger.info(
      { sandboxProvider: sandboxProviderName, ownerUserId },
      "Created a thread; creating its sandbox",
    );
    const creation = this.#createSandbox(threadId, supervisorToken.token, logger);
    this.#sandboxCreationsInProgress.add(creation);
    void creation.finally(() => this.#sandboxCreationsInProgress.delete(creation));
    return thread;
  }

  /** Resolves once every sandbox creation started so far has finished, however it ended. */
  async whenSandboxCreationsSettle(): Promise<void> {
    await Promise.all(this.#sandboxCreationsInProgress);
  }

  /** Never rejects: every outcome ends in the thread's record or, failing that, in the log. */
  async #createSandbox(threadId: string, supervisorToken: string, logger: Logger): Promise<void> {
    const supervisorEnvironment = buildSupervisorEnvironment(
      this.#options.supervisorEnvironment,
      threadId,
      supervisorToken,
    );
    const outcome = await this.#requestSandbox(threadId, supervisorEnvironment, logger);
    if (!outcome.ok) {
      await this.#recordFailure(threadId, outcome.reason, logger);
      return;
    }
    try {
      await this.#options.threadStore.recordSandboxReady(threadId, outcome.sandboxId);
      logger.info({ sandboxId: outcome.sandboxId }, "The thread's sandbox is ready");
    } catch (error) {
      logger.error(
        { err: error, sandboxId: outcome.sandboxId },
        "Could not record the thread's new sandbox; destroying it so that it is not left running unrecorded",
      );
      await this.#destroySandbox(outcome.sandboxId, logger);
      await this.#recordFailure(
        threadId,
        "The control plane could not record this thread's sandbox, so it removed it again. Create a new thread to try again.",
        logger,
      );
    }
  }

  /**
   * Asks the provider for the sandbox, trying again while it is unavailable.
   * A thread's identifier is minted afresh by this control plane, so a
   * sandbox that already exists for it on a later attempt can only be one
   * an earlier attempt created after all (a request that timed out but went
   * through), and it is taken as the thread's. On the first attempt there is
   * no such explanation, so it is a failure.
   */
  async #requestSandbox(
    threadId: string,
    supervisorEnvironment: Record<string, string>,
    logger: Logger,
  ): Promise<SandboxRequestOutcome> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { sandboxId } = await this.#options.sandboxProvider.create({
          threadId,
          supervisorEnvironment,
        });
        return { ok: true, sandboxId };
      } catch (error) {
        if (error instanceof SandboxAlreadyExistsError && attempt > 1) {
          logger.warn(
            { sandboxId: error.existingSandboxId, attempt },
            "An earlier attempt created the thread's sandbox after all; using it",
          );
          return { ok: true, sandboxId: error.existingSandboxId };
        }
        const retryDelayInMilliseconds = this.#retryDelaysInMilliseconds[attempt - 1];
        if (
          error instanceof SandboxProviderUnavailableError &&
          retryDelayInMilliseconds !== undefined
        ) {
          logger.warn(
            { err: error, attempt, retryDelayInMilliseconds },
            "The sandbox provider is unavailable; trying again",
          );
          await sleep(retryDelayInMilliseconds);
          continue;
        }
        logger.error({ err: error, attempt }, "Could not create the thread's sandbox");
        return { ok: false, reason: describeCreationFailure(error) };
      }
    }
  }

  async #recordFailure(threadId: string, reason: string, logger: Logger): Promise<void> {
    try {
      await this.#options.threadStore.recordSandboxFailed(threadId, reason);
    } catch (error) {
      logger.error(
        { err: error, reason },
        "Could not record that the thread's sandbox failed; the thread stays marked as creating",
      );
    }
  }

  async #destroySandbox(sandboxId: string, logger: Logger): Promise<void> {
    try {
      await this.#options.sandboxProvider.destroy(sandboxId);
      logger.info({ sandboxId }, "Destroyed the unrecorded sandbox");
    } catch (error) {
      logger.error(
        { err: error, sandboxId },
        "Could not destroy the unrecorded sandbox; it is left behind and must be removed by hand",
      );
    }
  }
}

/**
 * The reason the user is shown. Provider errors say what was attempted and
 * what went wrong, and never contain the supervisor's environment; anything
 * else is a bug, whose details belong in the log rather than on the page.
 */
function describeCreationFailure(error: unknown): string {
  if (error instanceof SandboxProviderUnavailableError) {
    return limitLength(
      `${error.message}. The sandbox provider may be back later; create a new thread to try again.`,
    );
  }
  if (error instanceof SandboxProviderError) {
    return limitLength(`${error.message}.`);
  }
  return "The control plane failed unexpectedly while creating this thread's sandbox; its log has the details.";
}

function limitLength(reason: string): string {
  return reason.length <= maximumErrorMessageLength
    ? reason
    : `${reason.slice(0, maximumErrorMessageLength - 1)}…`;
}
