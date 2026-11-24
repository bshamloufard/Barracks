import { InMemoryThreadRepositoryStore } from "../repositories/in-memory-thread-repository-store.js";
import {
  type AdmissionOutcome,
  applyTransition,
  checkTransition,
  type FinishStoppingRequest,
  findBrokenLimit,
  isPlaceOccupyingState,
  type NewThread,
  type SandboxAdmission,
  type SandboxState,
  type SandboxTransition,
  type ThreadCreationOptions,
  type ThreadRecord,
  type ThreadStore,
  type TransitionOutcome,
} from "./thread-store.js";

/**
 * Keeps thread records in process memory, for local development and tests.
 * Every thread is forgotten when the process exits.
 *
 * Every method reads and changes the records in one synchronous step, so
 * the compare-and-set of each change, and the count behind each admission,
 * cannot be interleaved with another call's.
 *
 * Threads' repositories are kept in `repositories`, recorded and forgotten
 * with their threads.
 */
export class InMemoryThreadStore implements ThreadStore {
  /** In order of creation. */
  readonly #threads: ThreadRecord[] = [];
  readonly repositories: InMemoryThreadRepositoryStore;

  constructor(repositories = new InMemoryThreadRepositoryStore()) {
    this.repositories = repositories;
  }

  async create(thread: NewThread, options: ThreadCreationOptions): Promise<AdmissionOutcome> {
    if (this.#find(thread.threadId) !== undefined) {
      throw new Error(`A thread "${thread.threadId}" already exists`);
    }
    const limitReached = this.#checkAdmission(thread.ownerUserId, undefined, options.admission);
    if (limitReached !== undefined) {
      return limitReached;
    }
    const { supervisorTokenDigest, repository, ...threadFields } = thread;
    const record: ThreadRecord = {
      ...threadFields,
      supervisorTokenDigests: [Buffer.from(supervisorTokenDigest)],
      createdAt: options.at,
      sandbox: { state: "creating", leaseExpiresAt: options.leaseExpiresAt },
      version: 1,
      title: undefined,
      lastActivityAt: options.at,
      isWakeRequested: false,
    };
    this.#threads.push(record);
    if (repository !== undefined) {
      this.repositories.recordNewThread(thread.threadId, repository);
    }
    return { kind: "changed", thread: copyOf(record) };
  }

  async transition(transition: SandboxTransition): Promise<TransitionOutcome> {
    const current = this.#find(transition.threadId);
    if (checkTransition(current, transition) === "conflict" || current === undefined) {
      return { kind: "conflict" };
    }
    if (transition.admission !== undefined) {
      const limitReached = this.#checkAdmission(
        current.ownerUserId,
        current.threadId,
        transition.admission,
      );
      if (limitReached !== undefined) {
        return limitReached;
      }
    }
    return { kind: "changed", thread: this.#replace(applyTransition(current, transition)) };
  }

  async finishStopping(request: FinishStoppingRequest): Promise<TransitionOutcome> {
    const current = this.#find(request.threadId);
    if (current?.version !== request.fromVersion || current.sandbox.state !== "stopping") {
      return { kind: "conflict" };
    }
    const { sandboxId } = current.sandbox;
    const changed: ThreadRecord = {
      ...current,
      sandbox: current.isWakeRequested
        ? { state: "starting", sandboxId, leaseExpiresAt: request.wakeLeaseExpiresAt }
        : { state: "stopped", sandboxId, problem: undefined },
      version: current.version + 1,
      isWakeRequested: false,
    };
    return { kind: "changed", thread: this.#replace(changed) };
  }

  async renewLease(threadId: string, version: number, leaseExpiresAt: Date): Promise<boolean> {
    const current = this.#find(threadId);
    if (current?.version !== version || !("leaseExpiresAt" in current.sandbox)) {
      return false;
    }
    this.#replace({ ...current, sandbox: { ...current.sandbox, leaseExpiresAt } });
    return true;
  }

  async recordUserMessageArrival(
    threadId: string,
    arrival: { at: Date; title: string | undefined },
  ): Promise<ThreadRecord | undefined> {
    const current = this.#find(threadId);
    if (current === undefined) {
      return undefined;
    }
    return this.#replace({
      ...current,
      lastActivityAt: arrival.at,
      title: current.title ?? arrival.title,
      isWakeRequested: current.isWakeRequested || current.sandbox.state === "stopping",
    });
  }

  async recordActivity(threadId: string, at: Date): Promise<void> {
    const current = this.#find(threadId);
    if (current !== undefined) {
      this.#replace({ ...current, lastActivityAt: at });
    }
  }

  async remove(threadId: string, version: number): Promise<boolean> {
    const index = this.#threads.findIndex((record) => record.threadId === threadId);
    const current = this.#threads[index];
    if (current?.version !== version || current.sandbox.state !== "deleting") {
      return false;
    }
    this.#threads.splice(index, 1);
    this.repositories.forgetThread(threadId);
    return true;
  }

  async find(threadId: string): Promise<ThreadRecord | undefined> {
    const record = this.#find(threadId);
    return record === undefined ? undefined : copyOf(record);
  }

  async findOwnedBy(ownerUserId: string, threadId: string): Promise<ThreadRecord | undefined> {
    const record = this.#find(threadId);
    return record?.ownerUserId === ownerUserId ? copyOf(record) : undefined;
  }

  async listMostRecentlyActiveOwnedBy(ownerUserId: string, limit: number): Promise<ThreadRecord[]> {
    return mostRecentlyActiveFirst(
      this.#threads.filter((record) => record.ownerUserId === ownerUserId),
    )
      .slice(0, limit)
      .map(copyOf);
  }

  async listInStates(states: readonly SandboxState[], limit: number): Promise<ThreadRecord[]> {
    return this.#threads
      .filter((record) => states.includes(record.sandbox.state))
      .slice(0, limit)
      .map(copyOf);
  }

  async listRunningInactiveSince(cutoff: Date, limit: number): Promise<ThreadRecord[]> {
    return this.#threads
      .filter(
        (record) =>
          record.sandbox.state === "running" && record.lastActivityAt.getTime() <= cutoff.getTime(),
      )
      .slice(0, limit)
      .map(copyOf);
  }

  /** Counts every thread occupying a place except `admittedThreadId`, which is the one asking. */
  #checkAdmission(
    ownerUserId: string | undefined,
    admittedThreadId: string | undefined,
    admission: SandboxAdmission,
  ): AdmissionOutcome | undefined {
    const occupying = this.#threads.filter(
      (record) =>
        record.threadId !== admittedThreadId && isPlaceOccupyingState(record.sandbox.state),
    );
    const occupyingOwned = occupying.filter((record) => record.ownerUserId === ownerUserId);
    const brokenLimit = findBrokenLimit(admission, occupyingOwned.length, occupying.length);
    if (brokenLimit === undefined) {
      return undefined;
    }
    return {
      kind: "limit_reached",
      ...brokenLimit,
      occupying: mostRecentlyActiveFirst(occupyingOwned).map(copyOf),
    };
  }

  /** Stores a changed record in place of the one with its identifier, and returns a copy. */
  #replace(changed: ThreadRecord): ThreadRecord {
    const index = this.#threads.findIndex((record) => record.threadId === changed.threadId);
    this.#threads[index] = changed;
    return copyOf(changed);
  }

  #find(threadId: string): ThreadRecord | undefined {
    return this.#threads.find((record) => record.threadId === threadId);
  }
}

/** Of two threads last active at the same moment, the one created later comes first. */
function mostRecentlyActiveFirst(records: ThreadRecord[]): ThreadRecord[] {
  return records
    .map((record, creationIndex) => ({ record, creationIndex }))
    .sort(
      (first, second) =>
        second.record.lastActivityAt.getTime() - first.record.lastActivityAt.getTime() ||
        second.creationIndex - first.creationIndex,
    )
    .map(({ record }) => record);
}

/** Callers get copies, as they would from a database, so they cannot change the store's records. */
function copyOf(record: ThreadRecord): ThreadRecord {
  return {
    ...record,
    supervisorTokenDigests: record.supervisorTokenDigests.map((digest) => Buffer.from(digest)),
    createdAt: new Date(record.createdAt),
    lastActivityAt: new Date(record.lastActivityAt),
    sandbox: { ...record.sandbox },
  };
}
