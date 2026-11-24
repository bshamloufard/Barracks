import type { RepositoryAccess } from "@barrack/protocol";

/**
 * The repository a thread started from, as the control plane keeps it.
 * It is recorded with the thread, in the same step (see `NewThread`), so no
 * thread's sandbox is ever made without the repository it was asked for.
 */
export type NewThreadRepository = {
  /** The URL the sandbox clones, as `parseRepositoryUrl` normalised it. */
  url: string;
  access: RepositoryAccess;
  /**
   * The branch to start from. Undefined means the repository's default
   * branch, which the sandbox finds out when it clones; for a `github_app`
   * repository it is always known, since a pull request needs it.
   */
  baseBranch: string | undefined;
  /** `barrack/<thread id>`: the agent's branch, and the only one ever published. */
  workBranch: string;
  /** For `github_app`: which repository, through which installation of the App. */
  github: GithubRepositoryReference | undefined;
};

export type GithubRepositoryReference = {
  repositoryId: number;
  installationId: number;
  /** `owner/name`, as GitHub spelled it when the user's access was verified. */
  fullName: string;
  /** The repository's page, for links to the branch. */
  htmlUrl: string;
};

/** What is known of the work branch's publication. */
export type RepositoryPublication = {
  /** The commit the control plane last pushed to the work branch. */
  lastPublishedCommit: string | undefined;
  /** The pull request opened for the work branch, if any. */
  pullRequest: { number: number; url: string } | undefined;
};

export type ThreadRepositoryRecord = NewThreadRepository &
  RepositoryPublication & { threadId: string };

/**
 * Reads threads' repositories and records what publishing did. A thread's
 * repository is written with the thread itself and removed with it.
 */
export interface ThreadRepositoryStore {
  find(threadId: string): Promise<ThreadRepositoryRecord | undefined>;

  /** The repositories of those of the threads that have one. */
  findMany(threadIds: readonly string[]): Promise<Map<string, ThreadRepositoryRecord>>;

  /**
   * Records a publication: the commit pushed and, once there is one, the
   * pull request. A pull request already recorded is kept, so a
   * publication that did not open one (another control plane's, finishing
   * second) never makes the thread forget it.
   */
  recordPublication(threadId: string, publication: RepositoryPublication): Promise<void>;
}
