import type { NewThreadRepository } from "../repositories/thread-repository-store.js";

/**
 * The control plane's record of every thread: who owns it, which provider
 * hosts its sandbox and which sandbox that is, what state that sandbox
 * should be in and is in, when the thread was last active, and the digest
 * of the token its supervisor proves itself with. Thread events live in the
 * thread event log; this holds what the control plane needs to run the
 * thread.
 *
 * Every change to a sandbox's state is a compare-and-set on the thread's
 * `version`: the caller names the version it read, and the change is made
 * only if the thread is still at it, which also moves the version on. So of
 * two control planes, or two requests, acting on the same reading, exactly
 * one succeeds; the other learns of the conflict and must read again. The
 * store also refuses any change `legalSandboxTransitions` does not list.
 */
export interface ThreadStore {
  /**
   * Records a new thread whose sandbox is about to be created, unless its
   * owner (or the installation) already has as many sandboxes occupying a
   * place as `admission` allows. Throws if a thread with that identifier
   * exists.
   */
  create(thread: NewThread, options: ThreadCreationOptions): Promise<AdmissionOutcome>;

  /** Changes a thread's sandbox state, if it is still at `fromVersion`; see `SandboxTransition`. */
  transition(transition: SandboxTransition): Promise<TransitionOutcome>;

  /**
   * Ends a stop: the sandbox becomes `stopped`, or, if a user message asked
   * for it to wake while it was stopping, `starting` with `wakeLeaseExpiresAt`.
   * Made only if the thread is still `stopping` at `fromVersion`.
   */
  finishStopping(request: FinishStoppingRequest): Promise<TransitionOutcome>;

  /**
   * Extends the lease on the operation under way, if the thread is still at
   * `version`; returns false if it is not, which means another control plane
   * took the operation over or it was cancelled.
   */
  renewLease(threadId: string, version: number, leaseExpiresAt: Date): Promise<boolean>;

  /**
   * Notes that a user message is about to be recorded: the thread was
   * active at `at`, takes `title` if it has none, and, if its sandbox is
   * stopping, is asked to wake once it has stopped. Neither changes the
   * version, so an operation under way is not disturbed. Returns the thread
   * as it now is, or undefined if it does not exist.
   */
  recordUserMessageArrival(
    threadId: string,
    arrival: { at: Date; title: string | undefined },
  ): Promise<ThreadRecord | undefined>;

  /** Notes that the thread was active at `at`, such as when its agent did something. */
  recordActivity(threadId: string, at: Date): Promise<void>;

  /**
   * Switches the thread's model, if it exists and belongs to `ownerUserId`;
   * returns the thread as it now is, or undefined. It does not change the
   * version: no operation under way depends on the model.
   */
  changeModel(
    ownerUserId: string,
    threadId: string,
    model: string,
  ): Promise<ThreadRecord | undefined>;

  /**
   * Removes a thread being deleted, if it is still at `version`. Returns
   * whether it was removed.
   */
  remove(threadId: string, version: number): Promise<boolean>;

  /**
   * The thread, or undefined if there is none with that identifier. Whoever
   * owns it: for the control plane's own work, such as checking a
   * supervisor's token. Anything answering a user uses `findOwnedBy`.
   */
  find(threadId: string): Promise<ThreadRecord | undefined>;

  /**
   * The thread if it exists and belongs to `ownerUserId`; otherwise
   * undefined, whether it does not exist or belongs to someone else.
   */
  findOwnedBy(ownerUserId: string, threadId: string): Promise<ThreadRecord | undefined>;

  /** At most `limit` of the user's threads, the most recently active first. */
  listMostRecentlyActiveOwnedBy(ownerUserId: string, limit: number): Promise<ThreadRecord[]>;

  /** At most `limit` threads of any owner whose sandboxes are in one of `states`, for the control plane's own sweeps. */
  listInStates(states: readonly SandboxState[], limit: number): Promise<ThreadRecord[]>;

  /** Running sandboxes with no activity recorded after `cutoff`, for idle shutdown. */
  listRunningInactiveSince(cutoff: Date, limit: number): Promise<ThreadRecord[]>;
}

export const sandboxStates = [
  "creating",
  "running",
  "stopping",
  "stopped",
  "starting",
  "failed",
  "deleting",
] as const;

export type SandboxState = (typeof sandboxStates)[number];

/** States in which a provider operation is under way, held by a lease. */
export const operatingStates = [
  "creating",
  "starting",
  "stopping",
  "deleting",
] as const satisfies readonly SandboxState[];

/**
 * States that take one of the places the running-sandbox limit counts: the
 * sandbox runs, or is about to, or has not finished stopping.
 */
export const placeOccupyingStates = [
  "creating",
  "running",
  "starting",
  "stopping",
] as const satisfies readonly SandboxState[];

/**
 * Every change the store allows, from each state. A state may follow itself
 * only where an operation under way is taken over (a new lease), or a
 * failed sandbox is found to be gone.
 *
 * - creating → running when the provider made it; → failed when it could
 *   not.
 * - running → stopping (a user's stop, idle shutdown); → deleting; and, when
 *   reconciliation finds the provider stopped or lost it, → stopped or
 *   failed.
 * - stopping → stopped when the provider stopped it (or → starting, through
 *   `finishStopping`, when a message asked it to wake); → running, stopped
 *   or failed after a failed stop, as the provider then reports it.
 * - stopped → starting (resume, or a message waking it); → deleting; →
 *   running or failed when reconciliation finds it running or gone.
 * - starting → running; → stopped or failed after a failed start.
 * - failed → starting (resume, with a sandbox); → deleting; → running when
 *   reconciliation finds it running; → failed when it is found gone.
 * - deleting → running, stopped or failed when destroying it failed, as the
 *   provider then reports it; and otherwise the thread is removed.
 */
export const legalSandboxTransitions: Readonly<Record<SandboxState, readonly SandboxState[]>> = {
  creating: ["creating", "running", "failed"],
  running: ["stopping", "deleting", "stopped", "failed"],
  stopping: ["stopping", "stopped", "running", "failed"],
  stopped: ["starting", "deleting", "running", "failed"],
  starting: ["starting", "running", "stopped", "failed"],
  failed: ["starting", "deleting", "running", "failed"],
  deleting: ["deleting", "running", "stopped", "failed"],
};

export function isLegalSandboxTransition(from: SandboxState, to: SandboxState): boolean {
  return legalSandboxTransitions[from].includes(to);
}

export function isPlaceOccupyingState(state: SandboxState): boolean {
  return (placeOccupyingStates as readonly SandboxState[]).includes(state);
}

/**
 * What a thread's sandbox should be and is. `sandboxId` names it at the
 * thread's provider; a lease says until when the control plane performing
 * an operation holds it.
 *
 * - `creating`: the provider is being asked for it.
 * - `running`: it runs; `problem` says why a requested stop did not happen.
 * - `stopping`: the provider is stopping it, files kept.
 * - `stopped`: it is stopped with its files kept; `problem` says why a
 *   requested start or deletion did not happen.
 * - `starting`: the provider is starting it again.
 * - `failed`: something went wrong, as `reason` tells the user. With a
 *   sandbox it can be started again; without one it is gone.
 * - `deleting`: it is being destroyed, and then the thread removed.
 */
export type ThreadSandboxRecord =
  | { state: "creating"; leaseExpiresAt: Date }
  | { state: "running"; sandboxId: string; problem: string | undefined }
  | { state: "stopping"; sandboxId: string; leaseExpiresAt: Date }
  | { state: "stopped"; sandboxId: string; problem: string | undefined }
  | { state: "starting"; sandboxId: string; leaseExpiresAt: Date }
  | { state: "failed"; sandboxId: string | undefined; reason: string }
  | { state: "deleting"; sandboxId: string | undefined; leaseExpiresAt: Date };

export type NewThread = {
  threadId: string;
  /** The user the thread belongs to, who alone may see or control it. */
  ownerUserId: string;
  /** The provider asked for the sandbox, such as `docker`; a sandbox identifier means nothing to any other. */
  sandboxProvider: string;
  /** SHA-256 of the supervisor's token. The token itself is never stored. */
  supervisorTokenDigest: Buffer;
  /**
   * The model its agent runs on, as `provider/model`; none only where the
   * installation runs the fake agent, which needs none.
   */
  model?: string;
  /**
   * The repository the thread starts from, recorded in the same step as
   * the thread; read back through `ThreadRepositoryStore`.
   */
  repository?: NewThreadRepository;
};

export type ThreadCreationOptions = {
  /** Recorded as when it was created and last active. */
  at: Date;
  /** Until when this control plane holds the creation. */
  leaseExpiresAt: Date;
  admission: SandboxAdmission;
};

/**
 * How many sandboxes may occupy a place (`placeOccupyingStates`) at once:
 * per user, and optionally in the whole installation.
 */
export type SandboxAdmission = {
  maximumPerUser: number;
  maximumInInstallation: number | undefined;
};

export type ThreadRecord = Omit<
  NewThread,
  "ownerUserId" | "supervisorTokenDigest" | "repository" | "model"
> & {
  /**
   * Undefined for a thread created without one, and for threads created
   * before each had its own (they ran on the installation's one model).
   */
  model: string | undefined;
  /** Undefined only for a thread created before sign-in existed, which nobody may see. */
  ownerUserId: string | undefined;
  /**
   * SHA-256 of every token the thread's supervisor may hold: the one minted
   * with the thread, then one for each time its creation was taken over. A
   * sandbox the provider turns up during a take-over was made by some
   * earlier attempt, and nothing says which, so each is accepted.
   */
  supervisorTokenDigests: Buffer[];
  createdAt: Date;
  sandbox: ThreadSandboxRecord;
  /** Moves on with every change of `sandbox`; changes are made only at the version their caller read. */
  version: number;
  /** Derived from the first user message; undefined until there is one. */
  title: string | undefined;
  /** When a user or the agent last did something in the thread (creation counts). */
  lastActivityAt: Date;
  /** A user message arrived while the sandbox was stopping, so it should start again once stopped. */
  isWakeRequested: boolean;
};

/**
 * - `to`: the new sandbox state. The store checks the change is legal.
 * - `at`: now. A change to `running` records the thread as active then, so
 *   a sandbox that has just started gets a whole idle period.
 * - `admission`: for a change that takes a place (a resume, a wake): it is
 *   refused if the owner or installation is already at the limit, not
 *   counting this thread.
 * - `onlyIfLastActiveAt`: for idle shutdown: the change is made only if no
 *   activity was recorded since the thread was read.
 * - `addedSupervisorTokenDigest`: accepted from now on besides the earlier
 *   ones, for a creation taken over that gives the sandbox a new token.
 */
export type SandboxTransition = {
  threadId: string;
  fromVersion: number;
  to: ThreadSandboxRecord;
  at: Date;
  admission?: SandboxAdmission;
  onlyIfLastActiveAt?: Date;
  addedSupervisorTokenDigest?: Buffer;
};

export type FinishStoppingRequest = {
  threadId: string;
  fromVersion: number;
  wakeLeaseExpiresAt: Date;
};

/**
 * - `changed`: done; `thread` is the record as it now is.
 * - `conflict`: not done, because the thread is gone, has moved past
 *   `fromVersion`, or was active after `onlyIfLastActiveAt`.
 * - `limit_reached`: not done, because of the admission limit; `occupying`
 *   lists the owner's threads that take a place.
 */
export type TransitionOutcome =
  | { kind: "changed"; thread: ThreadRecord }
  | { kind: "conflict" }
  | LimitReached;

export type AdmissionOutcome = { kind: "changed"; thread: ThreadRecord } | LimitReached;

export type LimitReached = {
  kind: "limit_reached";
  /** Which limit: the owner's own, or the installation's. */
  limit: "per_user" | "installation";
  maximum: number;
  /** The owner's threads that occupy a place, the most recently active first. */
  occupying: ThreadRecord[];
};

/** Thrown for a change `legalSandboxTransitions` does not allow: a bug in the caller, not a race. */
export class IllegalSandboxTransitionError extends Error {
  constructor(threadId: string, from: SandboxState, to: SandboxState) {
    super(`Thread "${threadId}" cannot go from ${from} to ${to}`);
    this.name = "IllegalSandboxTransitionError";
  }
}

/**
 * Checks a transition against a record read at its version, the same way
 * for every store: the version, the activity condition, then legality.
 */
export function checkTransition(
  current: ThreadRecord | undefined,
  transition: SandboxTransition,
): "allowed" | "conflict" {
  if (current === undefined || current.version !== transition.fromVersion) {
    return "conflict";
  }
  const { onlyIfLastActiveAt } = transition;
  if (
    onlyIfLastActiveAt !== undefined &&
    current.lastActivityAt.getTime() !== onlyIfLastActiveAt.getTime()
  ) {
    return "conflict";
  }
  if (!isLegalSandboxTransition(current.sandbox.state, transition.to.state)) {
    throw new IllegalSandboxTransitionError(
      current.threadId,
      current.sandbox.state,
      transition.to.state,
    );
  }
  return "allowed";
}

/**
 * Which limit, if any, admitting one more sandbox would break, given the
 * threads that already occupy a place (other than the one being admitted).
 */
export function findBrokenLimit(
  admission: SandboxAdmission,
  occupiedByOwner: number,
  occupiedInInstallation: number,
): Omit<LimitReached, "occupying" | "kind"> | undefined {
  if (occupiedByOwner >= admission.maximumPerUser) {
    return { limit: "per_user", maximum: admission.maximumPerUser };
  }
  const { maximumInInstallation } = admission;
  if (maximumInInstallation !== undefined && occupiedInInstallation >= maximumInInstallation) {
    return { limit: "installation", maximum: maximumInInstallation };
  }
  return undefined;
}

/**
 * The record a state change leaves: the new sandbox state, the next
 * version, no wake request (unless a stop is only being taken over), any
 * token digest added, and, entering `running`, activity now.
 */
export function applyTransition(
  current: ThreadRecord,
  transition: SandboxTransition,
): ThreadRecord {
  const isStopTakenOver =
    current.sandbox.state === "stopping" && transition.to.state === "stopping";
  return {
    ...current,
    sandbox: transition.to,
    version: current.version + 1,
    isWakeRequested: isStopTakenOver && current.isWakeRequested,
    lastActivityAt: transition.to.state === "running" ? transition.at : current.lastActivityAt,
    supervisorTokenDigests:
      transition.addedSupervisorTokenDigest === undefined
        ? current.supervisorTokenDigests
        : [...current.supervisorTokenDigests, transition.addedSupervisorTokenDigest],
  };
}
