import { z } from "zod";
import { maximumErrorMessageLength } from "./limits.js";
import { branchNameSchema, commitIdSchema, maximumRepositoryUrlLength } from "./repositories.js";

/**
 * Thread events about the thread's repository. They describe what happened
 * in terms of Git and the repository, never of any agent harness, and they
 * carry no credential of any kind: they are stored and replayed for ever.
 *
 * The sandbox's supervisor reports the clone (numbered and acknowledged like
 * the agent's events); the control plane reports publishing, which only it
 * does.
 */

const errorMessageSchema = z.string().min(1).max(maximumErrorMessageLength);
const repositoryUrlSchema = z.string().min(1).max(maximumRepositoryUrlLength);

/** The supervisor began cloning the repository, before the agent was given anything. */
export const repositoryCloneStartedEventSchema = z.strictObject({
  type: z.literal("repository_clone_started"),
  repositoryUrl: repositoryUrlSchema,
  /** The branch asked for; null means the repository's default branch. */
  baseBranch: branchNameSchema.nullable(),
});

/**
 * The repository is in the workspace, on `workBranch`, made from
 * `baseBranch` at `baseCommit`. `lostEarlierWork` is true when the sandbox
 * was made afresh after the agent had already worked in an earlier one: its
 * uncommitted and unpublished work went with that sandbox.
 */
export const repositoryClonedEventSchema = z.strictObject({
  type: z.literal("repository_cloned"),
  baseBranch: branchNameSchema,
  baseCommit: commitIdSchema,
  workBranch: branchNameSchema,
  lostEarlierWork: z.boolean(),
});

/**
 * The clone failed, for the reason given. The agent is not given messages
 * while the workspace lacks the repository: each new message tries the
 * clone again first.
 */
export const repositoryCloneFailedEventSchema = z.strictObject({
  type: z.literal("repository_clone_failed"),
  errorMessage: errorMessageSchema,
});

/** The events a supervisor reports about preparing the workspace. */
export const workspaceEventSchema = z.discriminatedUnion("type", [
  repositoryCloneStartedEventSchema,
  repositoryClonedEventSchema,
  repositoryCloneFailedEventSchema,
]);

/**
 * The control plane pushed `commit` to `workBranch`. `pullRequest` is the
 * pull request for that branch, if one is open for it, and
 * `isPullRequestNew` says whether this publication opened it.
 */
export const repositoryPublishedEventSchema = z.strictObject({
  type: z.literal("repository_published"),
  workBranch: branchNameSchema,
  commit: commitIdSchema,
  branchUrl: z.url(),
  pullRequest: z.strictObject({ number: z.int().positive(), url: z.url() }).nullable(),
  isPullRequestNew: z.boolean(),
});

/** Publishing failed, for the reason given; nothing was changed in the repository unless it says so. */
export const repositoryPublicationFailedEventSchema = z.strictObject({
  type: z.literal("repository_publication_failed"),
  errorMessage: errorMessageSchema,
});

export const repositoryEventSchema = z.discriminatedUnion("type", [
  ...workspaceEventSchema.options,
  repositoryPublishedEventSchema,
  repositoryPublicationFailedEventSchema,
]);

export type RepositoryCloneStartedEvent = z.infer<typeof repositoryCloneStartedEventSchema>;
export type RepositoryClonedEvent = z.infer<typeof repositoryClonedEventSchema>;
export type RepositoryCloneFailedEvent = z.infer<typeof repositoryCloneFailedEventSchema>;
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;
export type RepositoryPublishedEvent = z.infer<typeof repositoryPublishedEventSchema>;
export type RepositoryPublicationFailedEvent = z.infer<
  typeof repositoryPublicationFailedEventSchema
>;
export type RepositoryEvent = z.infer<typeof repositoryEventSchema>;
