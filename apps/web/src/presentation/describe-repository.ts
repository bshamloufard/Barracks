import type { RepositoryEvent } from "@barrack/protocol";

export type RepositoryEventDescription = {
  tone: "progress" | "done" | "warning" | "error";
  text: string;
  /** A page on the repository's host the text refers to, such as the pull request. */
  link: { label: string; url: string } | undefined;
};

/** How the conversation tells the user what happened to the thread's repository. */
export function describeRepositoryEvent(event: RepositoryEvent): RepositoryEventDescription[] {
  switch (event.type) {
    case "repository_clone_started":
      return [
        progress(
          `Cloning ${event.repositoryUrl}${event.baseBranch === null ? "" : ` at ${event.baseBranch}`}…`,
        ),
      ];
    case "repository_cloned":
      return [
        {
          tone: "done",
          text: `Cloned ${event.baseBranch} at ${shortCommit(event.baseCommit)}. The agent works on the branch ${event.workBranch}.`,
          link: undefined,
        },
        ...(event.lostEarlierWork
          ? [
              {
                tone: "warning" as const,
                text: "This thread's sandbox had to be made afresh, so the repository was cloned again: anything the agent had not published before (uncommitted changes and unpublished commits) was lost.",
                link: undefined,
              },
            ]
          : []),
      ];
    case "repository_clone_failed":
      return [{ tone: "error", text: event.errorMessage, link: undefined }];
    case "repository_published":
      return [
        {
          tone: "done",
          text: `Pushed ${shortCommit(event.commit)} to ${event.workBranch}.`,
          link: { label: "See the branch", url: event.branchUrl },
        },
        ...(event.pullRequest === null
          ? []
          : [
              {
                tone: "done" as const,
                text: event.isPullRequestNew
                  ? `Opened pull request #${event.pullRequest.number}.`
                  : `Pull request #${event.pullRequest.number} now has these commits.`,
                link: { label: "See the pull request", url: event.pullRequest.url },
              },
            ]),
      ];
    case "repository_publication_failed":
      return [{ tone: "error", text: `Publishing failed: ${event.errorMessage}`, link: undefined }];
  }
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

function progress(text: string): RepositoryEventDescription {
  return { tone: "progress", text, link: undefined };
}
