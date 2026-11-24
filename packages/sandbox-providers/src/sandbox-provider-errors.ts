/**
 * The ways a provider operation can fail, as classes the caller can tell
 * apart with `instanceof`. Each says what was being attempted.
 *
 * Messages never contain the supervisor's environment. For the same reason
 * these errors never carry the provider's own error object as their `cause`:
 * HTTP client errors hold the request that failed, with its credentials and
 * body, and a logger that serialises causes would write those out.
 */
export abstract class SandboxProviderError extends Error {
  /** A short description of the operation that failed, such as "start sandbox abc". */
  readonly attemptedOperation: string;
  /** What went wrong, without the attempted operation. */
  readonly explanation: string;

  constructor(attemptedOperation: string, explanation: string) {
    super(`Could not ${attemptedOperation}: ${explanation}`);
    this.name = new.target.name;
    this.attemptedOperation = attemptedOperation;
    this.explanation = explanation;
  }
}

/** The sandbox does not exist, or is not one this provider manages. */
export class SandboxNotFoundError extends SandboxProviderError {
  readonly sandboxId: string;

  constructor(attemptedOperation: string, sandboxId: string) {
    super(attemptedOperation, `there is no sandbox "${sandboxId}"`);
    this.sandboxId = sandboxId;
  }
}

/**
 * The provider could not be reached or failed in a way that may pass, such
 * as a network error, a timeout, a rate limit or a server error. Trying the
 * same operation again later may succeed.
 */
export class SandboxProviderUnavailableError extends SandboxProviderError {}

/**
 * The provider understood the request and declined it, for example because a
 * quota or resource limit is reached, the credentials are rejected or the
 * configuration names an image that does not exist. Repeating the same request
 * will not help until something changes.
 */
export class SandboxRefusedError extends SandboxProviderError {}

/**
 * The sandbox image (or the provider's snapshot of it) the provider is
 * configured with cannot be found or fetched. Nothing a user does helps:
 * the installation's administrator must make it available.
 */
export class SandboxImageUnavailableError extends SandboxRefusedError {}

/** The thread already has a sandbox; `existingSandboxId` names it. */
export class SandboxAlreadyExistsError extends SandboxProviderError {
  readonly threadId: string;
  readonly existingSandboxId: string;

  constructor(threadId: string, existingSandboxId: string) {
    super(
      `create a sandbox for thread "${threadId}"`,
      `the thread already has sandbox "${existingSandboxId}"`,
    );
    this.threadId = threadId;
    this.existingSandboxId = existingSandboxId;
  }
}

/**
 * An operation failed part-way, and undoing what it had done failed as well,
 * so something it made or started is left behind. Both failures are kept:
 * the first says why the operation failed, the second why it could not be
 * undone, and `consequence` what is left for someone to clean up.
 *
 * It is a refusal, whatever the first failure was, because repeating the
 * operation automatically would find what was left behind rather than start
 * afresh: a second create, for one, would be told that the thread already
 * has the half-created sandbox, and could take it as ready.
 */
export function describeFailedUndo(
  failure: SandboxProviderError,
  undoFailure: SandboxProviderError,
  consequence: string,
): SandboxRefusedError {
  return new SandboxRefusedError(
    failure.attemptedOperation,
    `${failure.explanation}; undoing it failed too (${undoFailure.message}), so ${consequence}`,
  );
}
