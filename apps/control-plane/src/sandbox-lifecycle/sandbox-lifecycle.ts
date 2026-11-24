import { randomUUID } from "node:crypto";
import { workBranchFor } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { ThreadRepositoryChoice } from "../repositories/repository-requests.js";
import { mintSupervisorToken } from "../threads/supervisor-token.js";
import type {
  ThreadRecord,
  ThreadSandboxRecord,
  ThreadStore,
  TransitionOutcome,
} from "../threads/thread-store.js";
import { describeLimitReached } from "./lifecycle-messages.js";
import type { Clock, LifecycleTiming, SandboxLifecycleSettings } from "./lifecycle-settings.js";
import type { SandboxOperations } from "./sandbox-operations.js";
import { deriveThreadTitle } from "./thread-title.js";

export type SandboxLifecycleOptions = {
  threadStore: ThreadStore;
  operations: SandboxOperations;
  /** Recorded with each thread, so a sandbox identifier is never read against the wrong provider. */
  sandboxProviderName: string;
  settings: SandboxLifecycleSettings;
  timing: LifecycleTiming;
  clock: Clock;
  logger: Logger;
};

/**
 * What became of a user's request to create, stop, resume or delete a
 * thread. Accepted requests are carried out in the background; `thread` is
 * the record as the request left it.
 */
export type LifecycleRequestOutcome =
  | { kind: "accepted"; thread: ThreadRecord }
  | { kind: "not_found" }
  | { kind: "conflict"; message: string }
  | { kind: "limit_reached"; message: string };

export type UserMessageAdmission = { isAccepted: true } | { isAccepted: false; reason: string };

/** How often a request whose reading went stale reads the thread again before giving up. */
const attemptsPerRequest = 3;

/**
 * The control plane decides when a thread's sandbox runs. This is where
 * users' requests and their messages turn into changes of a sandbox's
 * state; `SandboxOperations` then carries each change out through the
 * provider, and reconciliation and idle shutdown (in this folder) make the
 * changes nobody asked for.
 *
 * - **Create** records the thread as `creating`, if its owner has a place
 *   under the running-sandbox limit, and creates its sandbox.
 * - **Stop** (from `running`): interrupt the agent, stop the sandbox with
 *   its files kept, and close any run still open in history.
 * - **Resume** (from `stopped`, or `failed` with a sandbox): start it again,
 *   if there is a place; its supervisor reattaches and the agent reopens its
 *   conversation.
 * - **Delete** (from `running`, `stopped` or `failed`): destroy the sandbox,
 *   then remove the thread and its history for good.
 * - **A message** to a thread whose sandbox is stopped wakes it, if there is
 *   a place, and waits in history until the agent is back; one sent while it
 *   is stopping wakes it once it has stopped.
 *
 * Each change is a compare-and-set on the version read (see `ThreadStore`),
 * so two requests, or two control planes, never both make the same change.
 * Every request is answered for the user's own threads only: another user's
 * thread is answered as missing.
 */
export class SandboxLifecycle {
  readonly #options: SandboxLifecycleOptions;
  /** When each thread's agent activity was last written, so it is written at most once an interval. */
  readonly #agentActivityRecordedAt = new Map<string, number>();

  constructor(options: SandboxLifecycleOptions) {
    this.#options = options;
  }

  /** `repository`, if given, is recorded with the thread; its work branch is named after it. */
  async createThread(
    ownerUserId: string,
    repository?: ThreadRepositoryChoice,
  ): Promise<LifecycleRequestOutcome> {
    const { threadStore, operations, sandboxProviderName, settings } = this.#options;
    const supervisorToken = mintSupervisorToken();
    const threadId = randomUUID();
    const outcome = await threadStore.create(
      {
        threadId,
        ownerUserId,
        sandboxProvider: sandboxProviderName,
        supervisorTokenDigest: supervisorToken.digest,
        ...(repository === undefined
          ? {}
          : { repository: { ...repository, workBranch: workBranchFor(threadId) } }),
      },
      {
        at: this.#options.clock(),
        leaseExpiresAt: operations.leaseExpiry(),
        admission: settings.admission,
      },
    );
    if (outcome.kind === "limit_reached") {
      return { kind: "limit_reached", message: describeLimitReached(outcome, "create") };
    }
    this.#options.logger.info(
      { threadId: outcome.thread.threadId, ownerUserId, sandboxProvider: sandboxProviderName },
      "Created a thread; creating its sandbox",
    );
    operations.carryOut(outcome.thread, supervisorToken);
    return { kind: "accepted", thread: outcome.thread };
  }

  stopThread(ownerUserId: string, threadId: string): Promise<LifecycleRequestOutcome> {
    return this.#changeOwnedThread(ownerUserId, threadId, "stop", (thread) => {
      if (thread.sandbox.state !== "running") {
        return { refusal: describeWhyNotStoppable(thread.sandbox) };
      }
      const { sandboxId } = thread.sandbox;
      return { to: { state: "stopping", sandboxId, leaseExpiresAt: this.#leaseExpiry() } };
    });
  }

  resumeThread(ownerUserId: string, threadId: string): Promise<LifecycleRequestOutcome> {
    return this.#changeOwnedThread(ownerUserId, threadId, "resume", (thread) => {
      const { sandbox } = thread;
      const isResumable =
        sandbox.state === "stopped" ||
        (sandbox.state === "failed" && sandbox.sandboxId !== undefined);
      if (!isResumable || sandbox.sandboxId === undefined) {
        return { refusal: describeWhyNotResumable(sandbox) };
      }
      return {
        to: {
          state: "starting",
          sandboxId: sandbox.sandboxId,
          leaseExpiresAt: this.#leaseExpiry(),
        },
        isAdmissionNeeded: true,
      };
    });
  }

  async deleteThread(ownerUserId: string, threadId: string): Promise<LifecycleRequestOutcome> {
    const outcome = await this.#changeOwnedThread(ownerUserId, threadId, "delete", (thread) => {
      const { sandbox } = thread;
      if (
        sandbox.state !== "running" &&
        sandbox.state !== "stopped" &&
        sandbox.state !== "failed"
      ) {
        return { refusal: describeWhyNotDeletable(sandbox) };
      }
      return {
        to: {
          state: "deleting",
          sandboxId: sandbox.sandboxId,
          leaseExpiresAt: this.#leaseExpiry(),
        },
      };
    });
    if (outcome.kind === "accepted") {
      this.#agentActivityRecordedAt.delete(threadId);
    }
    return outcome;
  }

  /**
   * Decides whether a user message to the thread is recorded, and gets its
   * thread ready for it, before it is recorded: the thread is noted active
   * (so idle shutdown, which checks for that, cannot stop the sandbox under
   * it), takes its title from the first message, and its sandbox is woken
   * if stopped, or asked to wake if stopping. A message that would need a
   * place under the limit when there is none is refused, rather than left
   * waiting for an agent that cannot start.
   */
  async admitUserMessage(threadId: string, text: string): Promise<UserMessageAdmission> {
    const { threadStore, operations, logger } = this.#options;
    let woken: ThreadRecord | undefined;
    for (let attempt = 1; attempt <= attemptsPerRequest; attempt += 1) {
      const thread = await threadStore.find(threadId);
      if (thread === undefined || thread.sandbox.state === "deleting") {
        return {
          isAccepted: false,
          reason: "This thread is being deleted, so it takes no more messages.",
        };
      }
      if (thread.sandbox.state !== "stopped") {
        break;
      }
      const outcome = await this.#transition(
        thread,
        {
          state: "starting",
          sandboxId: thread.sandbox.sandboxId,
          leaseExpiresAt: this.#leaseExpiry(),
        },
        true,
      );
      if (outcome.kind === "limit_reached") {
        return { isAccepted: false, reason: describeLimitReached(outcome, "wake") };
      }
      if (outcome.kind === "changed") {
        woken = outcome.thread;
        break;
      }
    }
    await threadStore.recordUserMessageArrival(threadId, {
      at: this.#options.clock(),
      title: deriveThreadTitle(text),
    });
    if (woken !== undefined) {
      logger.info({ threadId }, "A message arrived for a stopped sandbox; waking it");
      operations.carryOut(woken);
    }
    return { isAccepted: true };
  }

  /**
   * Notes that the thread's agent did something, before it is recorded, at
   * most once per interval per thread; see `LifecycleTiming`. A failure is
   * logged and not fatal: at worst the sandbox stops while the agent is
   * quiet, never while it has a run open.
   */
  async recordAgentActivity(threadId: string): Promise<void> {
    const now = this.#options.clock();
    const lastRecordedAt = this.#agentActivityRecordedAt.get(threadId);
    const interval = this.#options.timing.agentActivityRecordingIntervalInMilliseconds;
    if (lastRecordedAt !== undefined && now.getTime() - lastRecordedAt < interval) {
      return;
    }
    try {
      await this.#options.threadStore.recordActivity(threadId, now);
      this.#agentActivityRecordedAt.set(threadId, now.getTime());
    } catch (error) {
      this.#options.logger.error({ err: error, threadId }, "Could not record the agent's activity");
    }
  }

  /**
   * Reads the user's thread, decides the change, and makes it, reading
   * again if another request changed the thread in between.
   */
  async #changeOwnedThread(
    ownerUserId: string,
    threadId: string,
    request: string,
    decide: (thread: ThreadRecord) => RequestedChange,
  ): Promise<LifecycleRequestOutcome> {
    for (let attempt = 1; attempt <= attemptsPerRequest; attempt += 1) {
      const thread = await this.#options.threadStore.findOwnedBy(ownerUserId, threadId);
      if (thread === undefined) {
        return { kind: "not_found" };
      }
      const change = decide(thread);
      if ("refusal" in change) {
        return { kind: "conflict", message: change.refusal };
      }
      const outcome = await this.#transition(thread, change.to, change.isAdmissionNeeded ?? false);
      if (outcome.kind === "limit_reached") {
        return { kind: "limit_reached", message: describeLimitReached(outcome, "resume") };
      }
      if (outcome.kind === "changed") {
        this.#options.logger.info(
          { threadId, ownerUserId, sandboxState: change.to.state },
          `A user asked to ${request} the thread`,
        );
        this.#options.operations.carryOut(outcome.thread);
        return { kind: "accepted", thread: outcome.thread };
      }
    }
    return {
      kind: "conflict",
      message: "The thread kept changing while this request was made. Try again.",
    };
  }

  #transition(
    thread: ThreadRecord,
    to: ThreadSandboxRecord,
    isAdmissionNeeded: boolean,
  ): Promise<TransitionOutcome> {
    return this.#options.threadStore.transition({
      threadId: thread.threadId,
      fromVersion: thread.version,
      to,
      at: this.#options.clock(),
      ...(isAdmissionNeeded ? { admission: this.#options.settings.admission } : {}),
    });
  }

  #leaseExpiry(): Date {
    return this.#options.operations.leaseExpiry();
  }
}

type RequestedChange =
  | { refusal: string }
  | { to: ThreadSandboxRecord; isAdmissionNeeded?: boolean };

function describeWhyNotStoppable(sandbox: ThreadSandboxRecord): string {
  switch (sandbox.state) {
    case "creating":
    case "starting":
      return "Its sandbox is starting; stop it once it is running.";
    case "stopping":
      return "Its sandbox is already stopping.";
    case "stopped":
      return "Its sandbox is already stopped.";
    case "deleting":
      return "This thread is being deleted.";
    default:
      return "Its sandbox is not running, so there is nothing to stop.";
  }
}

function describeWhyNotResumable(sandbox: ThreadSandboxRecord): string {
  switch (sandbox.state) {
    case "running":
      return "Its sandbox is already running.";
    case "creating":
    case "starting":
      return "Its sandbox is already starting.";
    case "stopping":
      return "Its sandbox is stopping; resume it once it has stopped.";
    case "deleting":
      return "This thread is being deleted.";
    default:
      return "Its sandbox is gone, so it cannot be resumed. Delete this thread and start a new one.";
  }
}

function describeWhyNotDeletable(sandbox: ThreadSandboxRecord): string {
  switch (sandbox.state) {
    case "deleting":
      return "This thread is already being deleted.";
    default:
      return "Its sandbox is busy starting or stopping; delete the thread once that has finished.";
  }
}
