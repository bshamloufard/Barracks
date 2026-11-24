import { z } from "zod";
import { identifierSchema, threadIdSchema } from "./identifier.js";
import { maximumErrorMessageLength } from "./limits.js";
import type { ParseResult } from "./parse-result.js";
import {
  branchNameSchema,
  maximumRepositoryUrlLength,
  repositoryAccessSchema,
} from "./repositories.js";

/**
 * Messages between a supervisor and the control plane about the thread's
 * workspace: the repository to clone, credentials for reading it, and the
 * bundle of the agent's commits the control plane publishes. They travel on
 * the supervisor's WebSocket (see `supervisor-messages.ts`) but are not
 * acknowledged or resent: each is a request whose asker gives up, and may
 * try again, if no answer comes.
 *
 * 1. Right after `supervisor_welcome`, and before any user message, the
 *    control plane sends `prepare_workspace`. The supervisor clones the
 *    repository, unless it already has, before handing the agent anything.
 * 2. For a `github_app` repository, Git in the sandbox asks for credentials
 *    through a helper that asks the supervisor, which sends
 *    `repository_credential_request`. The control plane answers
 *    `repository_credential` with a read-only token for that one repository,
 *    or a refusal. It decides which repository from the connection, never
 *    from anything in the request.
 * 3. To publish, the control plane sends `create_publication_bundle`. The
 *    supervisor makes a Git bundle of the work branch's commits since the
 *    base commit and uploads it over HTTP (`buildPublicationBundleUploadPath`)
 *    with its own token, or answers `publication_bundle_failed`. A bundle
 *    can be far larger than a frame, so it does not travel on the socket.
 */

/** Generous for a display name; Git accepts longer, but nothing real needs it. */
export const maximumCommitAuthorNameLength = 256;

/** https://www.rfc-editor.org/errata/eid1690: 254 characters for a usable address. */
export const maximumCommitAuthorEmailLength = 254;

/**
 * A GitHub token is 40 characters today and is changing to a longer,
 * stateless format of no published length; 16 Ki leaves room for that.
 */
export const maximumRepositoryCredentialLength = 16 * 1024;

/** Who the agent's commits are attributed to: the thread's user, never the agent. */
export const commitAuthorSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(maximumCommitAuthorNameLength)
    .regex(/^[^<>\n\0]+$/, "must not contain '<', '>' or line breaks"),
  email: z
    .string()
    .min(3)
    .max(maximumCommitAuthorEmailLength)
    .regex(/^[^<>\s@]+@[^<>\s@]+$/, "must be an address without spaces or angle brackets"),
});

export const workspaceRepositorySchema = z.strictObject({
  url: z.string().min(1).max(maximumRepositoryUrlLength),
  access: repositoryAccessSchema,
  /** Null means the repository's default branch. */
  baseBranch: branchNameSchema.nullable(),
  workBranch: branchNameSchema,
  commitAuthor: commitAuthorSchema,
});

/**
 * What the workspace should hold. `repository` is null for a thread without
 * one. `agentHasWorkedBefore` says the thread's agent was handed messages in
 * an earlier sandbox; a supervisor that finds no clone of its own then
 * reports that the earlier work was lost.
 */
export const prepareWorkspaceSchema = z.strictObject({
  type: z.literal("prepare_workspace"),
  repository: workspaceRepositorySchema.nullable(),
  agentHasWorkedBefore: z.boolean(),
});

export const repositoryCredentialRequestSchema = z.strictObject({
  type: z.literal("repository_credential_request"),
  requestId: identifierSchema,
});

const reasonSchema = z.string().min(1).max(maximumErrorMessageLength);

/**
 * Answers a credential request. A granted credential is for HTTPS Basic
 * authentication to the thread's repository only, can only read it, and
 * stops working at `expiresAt`. It must never be written to disk, a URL, a
 * process's arguments, a log or a thread event.
 */
export const repositoryCredentialSchema = z.strictObject({
  type: z.literal("repository_credential"),
  requestId: identifierSchema,
  outcome: z.discriminatedUnion("isGranted", [
    z.strictObject({
      isGranted: z.literal(true),
      username: z.string().min(1).max(256),
      password: z.string().min(1).max(maximumRepositoryCredentialLength),
      expiresAt: z.iso.datetime(),
    }),
    z.strictObject({ isGranted: z.literal(false), reason: reasonSchema }),
  ]),
});

/**
 * Asks for the work branch's commits since the base commit as a Git
 * bundle, uploaded to `uploadPath` (resolved against the control plane's
 * URL) with the supervisor's token, and no larger than `maximumSizeInBytes`.
 */
export const createPublicationBundleSchema = z.strictObject({
  type: z.literal("create_publication_bundle"),
  publicationId: identifierSchema,
  uploadPath: z.string().min(1).max(1024),
  maximumSizeInBytes: z.int().positive(),
});

/** The bundle could not be made or sent, for the reason given; for the user. */
export const publicationBundleFailedSchema = z.strictObject({
  type: z.literal("publication_bundle_failed"),
  publicationId: identifierSchema,
  reason: reasonSchema,
});

export const supervisorWorkspaceMessageSchema = z.discriminatedUnion("type", [
  repositoryCredentialRequestSchema,
  publicationBundleFailedSchema,
]);

export const controlPlaneWorkspaceMessageSchema = z.discriminatedUnion("type", [
  prepareWorkspaceSchema,
  repositoryCredentialSchema,
  createPublicationBundleSchema,
]);

export type CommitAuthor = z.infer<typeof commitAuthorSchema>;
export type WorkspaceRepository = z.infer<typeof workspaceRepositorySchema>;
export type PrepareWorkspace = z.infer<typeof prepareWorkspaceSchema>;
export type RepositoryCredentialRequest = z.infer<typeof repositoryCredentialRequestSchema>;
export type RepositoryCredential = z.infer<typeof repositoryCredentialSchema>;
export type CreatePublicationBundle = z.infer<typeof createPublicationBundleSchema>;
export type PublicationBundleFailed = z.infer<typeof publicationBundleFailedSchema>;
export type SupervisorWorkspaceMessage = z.infer<typeof supervisorWorkspaceMessageSchema>;
export type ControlPlaneWorkspaceMessage = z.infer<typeof controlPlaneWorkspaceMessageSchema>;

const publicationBundlePathPattern =
  /^\/threads\/([^/]+)\/supervisor\/publication-bundles\/([^/?#]+)$/;

/**
 * Where a supervisor uploads a publication bundle with
 * `PUT` and `Authorization: Bearer <supervisor token>`.
 */
export function buildPublicationBundleUploadPath(threadId: string, publicationId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/supervisor/publication-bundles/${encodeURIComponent(publicationId)}`;
}

export type PublicationBundleUploadParameters = { threadId: string; publicationId: string };

export function parsePublicationBundleUploadPath(
  pathname: string,
): ParseResult<PublicationBundleUploadParameters> {
  const match = publicationBundlePathPattern.exec(pathname);
  const threadId = safelyDecode(match?.[1]);
  const publicationId = safelyDecode(match?.[2]);
  if (
    !threadIdSchema.safeParse(threadId).success ||
    !identifierSchema.safeParse(publicationId).success ||
    threadId === undefined ||
    publicationId === undefined
  ) {
    return { ok: false, errorMessage: `Path "${pathname}" is not a publication bundle upload.` };
  }
  return { ok: true, value: { threadId, publicationId } };
}

function safelyDecode(segment: string | undefined): string | undefined {
  if (segment === undefined) {
    return undefined;
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
