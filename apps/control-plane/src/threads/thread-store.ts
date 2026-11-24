/**
 * The control plane's record of every thread: when it was created, which
 * provider hosts its sandbox and which sandbox that is, and the digest of the
 * token its supervisor proves itself with. Thread events live in the thread
 * event log; this holds what the control plane needs to run the thread.
 */
export interface ThreadStore {
  /**
   * Records a new thread whose sandbox is about to be created. The store
   * assigns `createdAt`. Throws if a thread with that identifier exists.
   */
  create(thread: NewThread): Promise<ThreadRecord>;

  /** Records that a thread's sandbox exists. Throws unless its sandbox is being created. */
  recordSandboxReady(threadId: string, sandboxId: string): Promise<void>;

  /** Records why a thread's sandbox could not be created. Throws unless it is being created. */
  recordSandboxFailed(threadId: string, reason: string): Promise<void>;

  /**
   * Records every sandbox still being created as failed, with `reason`, and
   * returns those threads' identifiers. For use at startup only: a sandbox
   * being created then was being created by a control plane that has gone.
   */
  failSandboxesStillBeingCreated(reason: string): Promise<string[]>;

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

  /** At most `limit` of the user's threads, the most recently created first. */
  listNewestFirstOwnedBy(ownerUserId: string, limit: number): Promise<ThreadRecord[]>;
}

export type NewThread = {
  threadId: string;
  /** The user the thread belongs to, who alone may see or control it. */
  ownerUserId: string;
  /** The provider asked for the sandbox, such as `docker`; a sandbox identifier means nothing to any other. */
  sandboxProvider: string;
  /** SHA-256 of the supervisor's token. The token itself is never stored. */
  supervisorTokenDigest: Buffer;
};

/**
 * - `creating`: the provider has been, or is about to be, asked for it.
 * - `ready`: it exists, as `sandboxId` at the thread's provider.
 * - `failed`: it could not be created; `reason` is shown to the user.
 */
export type ThreadSandboxRecord =
  | { state: "creating" }
  | { state: "ready"; sandboxId: string }
  | { state: "failed"; reason: string };

export type ThreadRecord = Omit<NewThread, "ownerUserId"> & {
  /** Undefined only for a thread created before sign-in existed, which nobody may see. */
  ownerUserId: string | undefined;
  createdAt: Date;
  sandbox: ThreadSandboxRecord;
};

/** Thrown when an update names a thread that does not exist or is not in the state it needs. */
export class ThreadStateConflictError extends Error {
  constructor(threadId: string, attemptedChange: string) {
    super(
      `Could not ${attemptedChange} for thread "${threadId}": its sandbox is not being created`,
    );
    this.name = "ThreadStateConflictError";
  }
}
