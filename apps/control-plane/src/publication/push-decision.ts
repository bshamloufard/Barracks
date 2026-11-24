/**
 * Whether, and how, a publication may move the thread's work branch in the
 * user's repository from where it is (`remoteCommit`) to the commit being
 * published, decided by ancestry, never by commit identity alone:
 *
 * - a branch that does not exist yet is created;
 * - a fast-forward (the branch's commit is an ancestor of the new one) is
 *   always allowed, whoever pushed what is there, since nothing is lost;
 * - anything else replaces commits, and is allowed only over
 *   `replaceableCommit`: Barrack's own last push, with nothing anyone else
 *   pushed beneath it, and nobody having built on it since (it is still
 *   the branch's commit). The agent may rewrite its own work, and nobody
 *   else's.
 *
 * A branch already at the commit needs no push, and Barrack's record of what
 * it may replace is left as it was: a commit Barrack merely found there is
 * never taken for its own. Git's lease on `remoteCommit` makes the push fail
 * if anyone moves the branch between this decision and the push.
 */

export type PushDecision =
  | { kind: "already_there" }
  | {
      kind: "push";
      /** The lease: the push fails unless the branch is still here (absent, when undefined). */
      expectedRemoteCommit: string | undefined;
      /** What a later publication may replace once this push is made. */
      replaceableAfter: string | undefined;
    }
  | { kind: "refuse"; reason: string };

export type PushDecisionInput = {
  workBranch: string;
  /** The commit being published. */
  commit: string;
  /** Where the branch is in the repository now; undefined if it does not exist. */
  remoteCommit: string | undefined;
  replaceableCommit: string | undefined;
  /** Throws when Git cannot tell, which refuses the publication rather than guessing. */
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>;
};

export async function decidePush(input: PushDecisionInput): Promise<PushDecision> {
  const { commit, remoteCommit, replaceableCommit } = input;
  if (remoteCommit === undefined) {
    return { kind: "push", expectedRemoteCommit: undefined, replaceableAfter: commit };
  }
  if (remoteCommit === commit) {
    return { kind: "already_there" };
  }
  const isBarracksAlone = remoteCommit === replaceableCommit;
  if (await input.isAncestor(remoteCommit, commit)) {
    return {
      kind: "push",
      expectedRemoteCommit: remoteCommit,
      replaceableAfter: isBarracksAlone ? commit : undefined,
    };
  }
  if (isBarracksAlone) {
    return { kind: "push", expectedRemoteCommit: remoteCommit, replaceableAfter: commit };
  }
  return {
    kind: "refuse",
    reason: `${input.workBranch} in the repository holds commits someone else pushed, which publishing these commits would remove. Barrack never overwrites someone else's work, so it only adds to that branch: have the agent build on the branch as it is in the repository, or delete the branch on GitHub, then publish again.`,
  };
}
