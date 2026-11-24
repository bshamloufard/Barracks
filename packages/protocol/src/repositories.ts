import { z } from "zod";
import { maximumErrorMessageLength } from "./limits.js";

/**
 * A thread can start from one Git repository: the sandbox clones it before
 * the agent is given its first message, and the agent works on a branch of
 * Barrack's own naming. Publishing that branch (pushing it, and optionally
 * opening a pull request) is done by the control plane, never the sandbox.
 *
 * How the sandbox reads the repository:
 * - `none`: a public repository, cloned over HTTPS with no credential.
 *   Nothing can be published from it, since Barrack holds no way to write.
 * - `github_app`: a repository the user verified access to through the
 *   installation's GitHub App. The sandbox is given only short-lived,
 *   read-only credentials for this one repository; the control plane
 *   publishes with credentials that never enter the sandbox.
 */
export const repositoryAccessSchema = z.enum(["none", "github_app"]);

/** Long enough for any real repository URL; URLs are shown to users and stored. */
export const maximumRepositoryUrlLength = 2048;

/** Git allows longer names, but nothing a person chooses as a base branch comes near this. */
export const maximumBranchNameLength = 255;

/**
 * A branch name Barrack accepts: a conservative subset of what
 * `git check-ref-format --branch` allows, so that no name can be read as an
 * option, a revision expression or a path outside `refs/heads`.
 * https://git-scm.com/docs/git-check-ref-format
 */
export const branchNameSchema = z
  .string()
  .min(1)
  .max(maximumBranchNameLength)
  .regex(/^[A-Za-z0-9._/-]+$/, "may contain only letters, digits, '.', '_', '-' and '/'")
  .refine(isAcceptableBranchName, {
    error:
      "must not start with '-', '.' or '/', end with '/' or '.', or contain '..', '//', a part starting with '.' or ending with '.lock'",
  });

function isAcceptableBranchName(name: string): boolean {
  if (name.startsWith("-") || name.endsWith("/") || name.endsWith(".")) {
    return false;
  }
  if (name.includes("..") || name.includes("//")) {
    return false;
  }
  return name
    .split("/")
    .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** A full SHA-1 commit name; repositories using SHA-256 are refused. */
export const commitIdSchema = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-digit commit name");

/**
 * The one branch a thread's agent works on and the control plane publishes
 * to. A thread identifier is letters, digits, `_` and `-`, so the name is
 * always a valid branch name.
 */
export function workBranchFor(threadId: string): string {
  return `barrack/${threadId}`;
}

/** The repository a new thread starts from, as the user asks for it. */
export const threadRepositoryRequestSchema = z.strictObject({
  url: z.string().min(1).max(maximumRepositoryUrlLength),
  access: repositoryAccessSchema,
  /** The branch to start from; the repository's default branch when left out. */
  baseBranch: branchNameSchema.optional(),
});

const reasonSchema = z.string().min(1).max(maximumErrorMessageLength);

/**
 * Whether the thread's branch can be published, and if not, why not (the
 * repository is public and Barrack holds no way to write to it, say).
 */
export const repositoryPublishingSchema = z.discriminatedUnion("isAvailable", [
  z.strictObject({
    isAvailable: z.literal(true),
    /** The commit last pushed to the work branch, if any. */
    lastPublishedCommit: commitIdSchema.nullable(),
    /** The pull request opened for the work branch, if any. */
    pullRequestUrl: z.url().nullable(),
  }),
  z.strictObject({ isAvailable: z.literal(false), reason: reasonSchema }),
]);

/** What a thread's summary says about its repository. */
export const threadRepositorySummarySchema = z.strictObject({
  url: z.string().min(1).max(maximumRepositoryUrlLength),
  access: repositoryAccessSchema,
  /** The branch asked for; null means the repository's default branch. */
  baseBranch: branchNameSchema.nullable(),
  workBranch: branchNameSchema,
  publishing: repositoryPublishingSchema,
});

export type RepositoryAccess = z.infer<typeof repositoryAccessSchema>;
export type ThreadRepositoryRequest = z.infer<typeof threadRepositoryRequestSchema>;
export type RepositoryPublishing = z.infer<typeof repositoryPublishingSchema>;
export type ThreadRepositorySummary = z.infer<typeof threadRepositorySummarySchema>;
