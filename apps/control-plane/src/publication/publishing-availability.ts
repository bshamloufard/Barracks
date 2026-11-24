import type { RepositoryPublishing } from "@barrack/protocol";
import { githubUnavailableReason } from "../github/github-connections.js";
import type { ThreadRepositoryRecord } from "../repositories/thread-repository-store.js";

/**
 * Whether a thread's work branch can be published, and if not, the reason
 * the user is shown instead of a button that would only fail.
 */
export function describePublishing(
  repository: ThreadRepositoryRecord,
  isGithubAvailable: boolean,
): RepositoryPublishing {
  if (repository.access === "none") {
    return {
      isAvailable: false,
      reason:
        "This repository was cloned as a public repository, without credentials, so Barrack cannot push to it. To publish, start a thread on it through Barrack's GitHub App.",
    };
  }
  if (!isGithubAvailable) {
    return { isAvailable: false, reason: githubUnavailableReason };
  }
  return {
    isAvailable: true,
    lastPublishedCommit: repository.lastPublishedCommit ?? null,
    pullRequestUrl: repository.pullRequest?.url ?? null,
  };
}
