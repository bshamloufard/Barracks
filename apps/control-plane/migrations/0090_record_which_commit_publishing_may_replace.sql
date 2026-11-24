-- Publishing pushes a thread's work branch as a fast-forward, or replaces
-- what is there only when that is Barrack's own last push and nothing
-- anyone else pushed lies beneath it (see thread-publisher.ts). This column
-- names that one commit: set by a push onto a branch that was absent or
-- held only Barrack's own pushes, cleared by a push on top of someone
-- else's commit, and never set to a commit Barrack found there without
-- pushing it.
--
-- Existing rows start with none: under the earlier rule a commit found on
-- the branch could be recorded as Barrack's own, so no recorded commit is
-- trusted. A thread that published before this release can still add to
-- its branch, but not rewrite it, unless the branch is deleted on GitHub.
-- It only adds a nullable column, so a control plane of the previous
-- release, still serving while the new one starts, is unaffected.
alter table thread_repositories
  add column replaceable_commit text check (replaceable_commit ~ '^[0-9a-f]{40}$');
