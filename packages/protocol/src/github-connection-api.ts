import { z } from "zod";
import { maximumErrorMessageLength } from "./limits.js";
import { maximumRepositoryUrlLength } from "./repositories.js";

/**
 * Linking a user's GitHub account, so their threads can work on their
 * private repositories through the installation's GitHub App. Every route
 * needs the user's access token and is about that user alone.
 *
 * - `GET /api/github/connection`: whether GitHub can be used here at all,
 *   and if so whether the user is connected and with which repositories.
 * - `POST /api/github/connection-attempts` with `{}`: starts connecting;
 *   answers (201) the GitHub address to send the user to. GitHub sends them
 *   back to `githubCallbackPagePath` with `code` and `state`.
 * - `POST /api/github/connection` with `{ code, state }`: finishes
 *   connecting, from that page, as the same signed-in user who started.
 *   Answers the connection (200), or 400 `bad_request` when the attempt is
 *   unknown, used, expired or another user's.
 * - `DELETE /api/github/connection`: forgets the link (200).
 *
 * Only repositories the user can push to are offered, and only those
 * Barrack's App was installed on. Barrack keeps the user's GitHub identity
 * and that list; it keeps no GitHub token of the user's.
 */

export const githubConnectionApiPath = "/api/github/connection";
export const githubConnectionAttemptsApiPath = "/api/github/connection-attempts";

/** The web client's page GitHub sends the user back to; it must be the App's callback URL. */
export const githubCallbackPagePath = "/github/callback";

const reasonSchema = z.string().min(1).max(maximumErrorMessageLength);

export const linkedRepositorySchema = z.strictObject({
  /** `owner/name`, as GitHub spells it. */
  fullName: z.string().min(3).max(256),
  url: z.string().min(1).max(maximumRepositoryUrlLength),
  defaultBranch: z.string().min(1).max(255),
  isPrivate: z.boolean(),
});

export const githubConnectionSchema = z.discriminatedUnion("state", [
  /** This installation has no GitHub App configured; `reason` says so. */
  z.strictObject({ state: z.literal("unavailable"), reason: reasonSchema }),
  z.strictObject({ state: z.literal("not_connected"), installUrl: z.url() }),
  z.strictObject({
    state: z.literal("connected"),
    login: z.string().min(1).max(256),
    connectedAt: z.iso.datetime(),
    /** Where to install the App on more accounts or repositories; connect again afterwards. */
    installUrl: z.url(),
    repositories: z.array(linkedRepositorySchema),
  }),
]);

export const githubConnectionResponseSchema = z.strictObject({
  connection: githubConnectionSchema,
});

export const startGithubConnectionRequestSchema = z.strictObject({});

export const startGithubConnectionResponseSchema = z.strictObject({ authorizationUrl: z.url() });

/** What GitHub put in the callback page's address. */
export const finishGithubConnectionRequestSchema = z.strictObject({
  code: z.string().min(1).max(512),
  state: z.string().min(1).max(512),
});

export type LinkedRepository = z.infer<typeof linkedRepositorySchema>;
export type GithubConnection = z.infer<typeof githubConnectionSchema>;
export type GithubConnectionResponse = z.infer<typeof githubConnectionResponseSchema>;
export type StartGithubConnectionResponse = z.infer<typeof startGithubConnectionResponseSchema>;
export type FinishGithubConnectionRequest = z.infer<typeof finishGithubConnectionRequestSchema>;
