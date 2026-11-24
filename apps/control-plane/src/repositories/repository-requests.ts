import { branchNameSchema, type ThreadRepositoryRequest } from "@barrack/protocol";
import type { GithubApi } from "../github/github-api.js";
import type { GithubConnectionStore } from "../github/github-connection-store.js";
import { githubUnavailableReason } from "../github/github-connections.js";
import type { GithubSettings } from "../github/github-settings.js";
import { checkLiveRepositoryAccess } from "../github/live-repository-access.js";
import { parseRepositoryUrl, readGithubFullName } from "./repository-url.js";
import type { NewThreadRepository } from "./thread-repository-store.js";

/** A new thread's repository, all but the work branch, which is named after the thread. */
export type ThreadRepositoryChoice = Omit<NewThreadRepository, "workBranch">;

/**
 * - `accepted`: the repository to record with the new thread.
 * - `invalid`: the request itself is wrong (a URL Barrack does not accept).
 * - `not_allowed`: the user has not been verified to have the access the
 *   request needs.
 */
export type RepositoryRequestOutcome =
  | { kind: "accepted"; choice: ThreadRepositoryChoice }
  | { kind: "invalid"; message: string }
  | { kind: "not_allowed"; message: string };

export type RepositoryRequestsOptions = {
  settings: GithubSettings;
  api: GithubApi | undefined;
  connections: GithubConnectionStore;
};

/**
 * Decides whether a user may start a thread on the repository they asked
 * for. A public repository needs only an acceptable URL. A repository
 * reached through the GitHub App must be one the user was verified to push
 * to when they connected GitHub, and is checked with GitHub again now.
 */
export class RepositoryRequests {
  readonly #options: RepositoryRequestsOptions;

  constructor(options: RepositoryRequestsOptions) {
    this.#options = options;
  }

  async resolve(
    userId: string,
    request: ThreadRepositoryRequest,
  ): Promise<RepositoryRequestOutcome> {
    const location = parseRepositoryUrl(request.url, {
      allowPlainHttp: this.#options.settings.allowPlainHttp,
    });
    if (!location.ok) {
      return { kind: "invalid", message: location.errorMessage };
    }
    if (request.access === "none") {
      return {
        kind: "accepted",
        choice: {
          url: location.value.url,
          access: "none",
          baseBranch: request.baseBranch,
          github: undefined,
        },
      };
    }
    const fullName = readGithubFullName(location.value, this.#options.settings.webUrl);
    if (fullName === undefined) {
      return {
        kind: "invalid",
        message: `Only repositories on ${this.#options.settings.webUrl} can be reached through Barrack's GitHub App; give its address as ${this.#options.settings.webUrl}/owner/name.`,
      };
    }
    return this.#resolveThroughGithubApp(userId, fullName, request.baseBranch);
  }

  async #resolveThroughGithubApp(
    userId: string,
    fullName: string,
    baseBranch: string | undefined,
  ): Promise<RepositoryRequestOutcome> {
    const { api, connections } = this.#options;
    if (api === undefined) {
      return { kind: "not_allowed", message: githubUnavailableReason };
    }
    const connection = await connections.find(userId);
    if (connection === undefined) {
      return {
        kind: "not_allowed",
        message:
          "Connect your GitHub account in Settings before starting a thread on a private repository.",
      };
    }
    const repository = connection.repositories.find(
      (linked) => linked.fullName.toLowerCase() === fullName.toLowerCase(),
    );
    if (repository === undefined) {
      return {
        kind: "not_allowed",
        message: `${fullName} is not among the repositories you were verified to push to through Barrack's GitHub App. Install the App on it, then reconnect GitHub in Settings.`,
      };
    }
    const access = await checkLiveRepositoryAccess(api, connection, repository);
    if (!access.ok) {
      return { kind: "not_allowed", message: access.reason };
    }
    // A name the user gave was checked with the request; GitHub's default
    // branch is checked here, since the sandbox refuses a description of
    // the workspace with a branch name the protocol does not accept.
    const chosenBaseBranch = baseBranch ?? repository.defaultBranch;
    if (!branchNameSchema.safeParse(chosenBaseBranch).success) {
      return {
        kind: "invalid",
        message: `${repository.fullName}'s default branch, ${describeBranchName(chosenBaseBranch)}, is not a branch name Barrack can use. Name a base branch to start from instead.`,
      };
    }
    return {
      kind: "accepted",
      choice: {
        url: repository.cloneUrl,
        access: "github_app",
        baseBranch: chosenBaseBranch,
        github: {
          repositoryId: repository.id,
          installationId: repository.installationId,
          fullName: repository.fullName,
          htmlUrl: repository.htmlUrl,
        },
      },
    };
  }
}

/** Quoted, with any control character spelled out, since it would be invisible on the page. */
function describeBranchName(name: string): string {
  const spelled = name.replace(
    /\p{Cc}/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `"${spelled}"`;
}
