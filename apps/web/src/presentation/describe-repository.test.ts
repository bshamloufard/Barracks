import { describe, expect, it } from "vitest";
import { describeRepositoryEvent } from "./describe-repository";

const commit = "0123456789abcdef0123456789abcdef01234567";

describe("how the conversation tells what happened to the repository", () => {
  it("says which commit was cloned and which branch the agent works on", () => {
    expect(
      describeRepositoryEvent({
        type: "repository_cloned",
        baseBranch: "main",
        baseCommit: commit,
        workBranch: "barrack/thread-1",
        lostEarlierWork: false,
      }),
    ).toEqual([
      {
        tone: "done",
        text: "Cloned main at 0123456. The agent works on the branch barrack/thread-1.",
        link: undefined,
      },
    ]);
  });

  it("warns that unpublished work was lost when a sandbox was made afresh", () => {
    const descriptions = describeRepositoryEvent({
      type: "repository_cloned",
      baseBranch: "main",
      baseCommit: commit,
      workBranch: "barrack/thread-1",
      lostEarlierWork: true,
    });

    expect(descriptions[1]).toMatchObject({
      tone: "warning",
      text: expect.stringContaining("lost"),
    });
  });

  it("links the branch and the pull request a publication pushed and opened", () => {
    const descriptions = describeRepositoryEvent({
      type: "repository_published",
      workBranch: "barrack/thread-1",
      commit,
      branchUrl: "https://github.com/octo/app/tree/barrack/thread-1",
      pullRequest: { number: 7, url: "https://github.com/octo/app/pull/7" },
      isPullRequestNew: true,
    });

    expect(descriptions.map((description) => [description.text, description.link?.url])).toEqual([
      ["Pushed 0123456 to barrack/thread-1.", "https://github.com/octo/app/tree/barrack/thread-1"],
      ["Opened pull request #7.", "https://github.com/octo/app/pull/7"],
    ]);
  });

  it("shows a failed clone or publication as an error, in its own words", () => {
    expect(
      describeRepositoryEvent({
        type: "repository_clone_failed",
        errorMessage: "No such repository.",
      }),
    ).toEqual([{ tone: "error", text: "No such repository.", link: undefined }]);
    expect(
      describeRepositoryEvent({ type: "repository_publication_failed", errorMessage: "Refused." }),
    ).toEqual([{ tone: "error", text: "Publishing failed: Refused.", link: undefined }]);
  });
});
