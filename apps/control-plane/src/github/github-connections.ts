import { createHash, randomBytes } from "node:crypto";
import { branchNameSchema, type GithubConnection } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { Clock } from "../sandbox-lifecycle/lifecycle-settings.js";
import type { GithubApi, GithubRepository } from "./github-api.js";
import type {
  GithubConnectionRecord,
  GithubConnectionStore,
  LinkedGithubRepository,
} from "./github-connection-store.js";
import type { GithubSettings } from "./github-settings.js";

/** Long enough to sign in to GitHub and approve; short enough that a stolen state soon goes stale. */
const attemptLifetimeInMilliseconds = 10 * 60_000;

export type FinishOutcome =
  | { ok: true; connection: GithubConnection }
  | { ok: false; reason: "attempt_not_valid" | "github_refused"; message: string };

export type GithubConnectionsOptions = {
  settings: GithubSettings;
  /** Undefined when this installation has no GitHub App. */
  api: GithubApi | undefined;
  store: GithubConnectionStore;
  clock: Clock;
  logger: Logger;
};

export const githubUnavailableReason =
  "GitHub is not set up on this installation of Barrack: whoever runs it has not registered a GitHub App for it (see the deployment guide). Public repositories can still be cloned.";

/**
 * Links a Barrack user to their GitHub account, safely:
 *
 * - **Started by the signed-in user.** `start` mints a random `state`,
 *   records its digest with the user's identity and a PKCE verifier, and
 *   sends the user to GitHub with the state and the verifier's challenge.
 * - **Finished by the same user.** GitHub sends the browser back to the web
 *   client's callback page, which hands the code and state to `finish` with
 *   the user's own access token. The state must exist, be unused, unexpired
 *   and the same user's; it is consumed whatever happens. An attacker who
 *   starts a link and gets a victim's browser to the callback with the
 *   attacker's state is refused, because the victim's token names another
 *   user, and the state alone authenticates nobody.
 * - **Nothing from the redirect is trusted.** The installation and
 *   repositories come from asking GitHub with the user's own token, never
 *   from an `installation_id` in an address, which GitHub warns can be
 *   spoofed. Only repositories the user can push to are kept.
 * - **The user's token is thrown away** as soon as the list is read, and
 *   revoked on GitHub too, so none is kept anywhere.
 */
export class GithubConnections {
  readonly #options: GithubConnectionsOptions;

  constructor(options: GithubConnectionsOptions) {
    this.#options = options;
  }

  get isAvailable(): boolean {
    return this.#options.api !== undefined && this.#options.settings.app !== undefined;
  }

  /** The address that installs the App on more accounts or repositories. */
  get installUrl(): string {
    const slug = this.#options.settings.app?.slug ?? "";
    return `${this.#options.settings.webUrl}/apps/${encodeURIComponent(slug)}/installations/new`;
  }

  async describe(userId: string): Promise<GithubConnection> {
    if (!this.isAvailable) {
      return { state: "unavailable", reason: githubUnavailableReason };
    }
    const connection = await this.#options.store.find(userId);
    return connection === undefined
      ? { state: "not_connected", installUrl: this.installUrl }
      : this.#describeConnected(connection);
  }

  /** The address to send the user to, or undefined when GitHub is not set up. */
  async start(userId: string): Promise<string | undefined> {
    const app = this.#options.settings.app;
    if (app === undefined || !this.isAvailable) {
      return undefined;
    }
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    await this.#options.store.saveAttempt({
      stateDigest: digestOf(state),
      userId,
      codeVerifier,
      expiresAt: new Date(this.#options.clock().getTime() + attemptLifetimeInMilliseconds),
    });
    // No redirect_uri: GitHub then uses the App's first callback URL, which
    // the deployment guide says to set to the web client's callback page.
    const query = new URLSearchParams({
      client_id: app.clientId,
      state,
      code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
      code_challenge_method: "S256",
      allow_signup: "false",
    });
    return `${this.#options.settings.webUrl}/login/oauth/authorize?${query.toString()}`;
  }

  async finish(userId: string, code: string, state: string): Promise<FinishOutcome> {
    const { api, store, clock, logger } = this.#options;
    if (api === undefined) {
      return refuse("attempt_not_valid", githubUnavailableReason);
    }
    const attempt = await store.takeAttempt(digestOf(state));
    const isValid =
      attempt !== undefined &&
      attempt.userId === userId &&
      attempt.expiresAt.getTime() > clock().getTime();
    if (!isValid || attempt === undefined) {
      logger.warn(
        { userId },
        "Refused to finish a GitHub sign-in this user did not start, or that was used or expired",
      );
      return refuse(
        "attempt_not_valid",
        "This GitHub sign-in was not started by you on this page, was already used, or took too long. Start connecting GitHub again.",
      );
    }
    let userToken: string;
    try {
      userToken = await api.exchangeAuthorizationCode(code, attempt.codeVerifier);
    } catch (error) {
      logger.warn({ err: error, userId }, "GitHub did not accept a sign-in code");
      return refuse("github_refused", describeError(error));
    }
    try {
      const connection = await this.#readConnection(api, userId, userToken);
      await store.save(connection);
      logger.info(
        { userId, githubLogin: connection.login, repositoryCount: connection.repositories.length },
        "Linked a user's GitHub account",
      );
      return { ok: true, connection: this.#describeConnected(connection) };
    } catch (error) {
      logger.warn({ err: error, userId }, "Could not read a user's GitHub installations");
      return refuse("github_refused", describeError(error));
    } finally {
      await api.revokeUserToken(userToken).catch((error: unknown) => {
        logger.warn(
          { err: error, userId },
          "Could not revoke a user's GitHub token after use; it expires within eight hours",
        );
      });
    }
  }

  async forget(userId: string): Promise<void> {
    await this.#options.store.remove(userId);
    this.#options.logger.info({ userId }, "Forgot a user's GitHub link");
  }

  /** Who the user is on GitHub, and every repository of the App's installations they can push to. */
  async #readConnection(
    api: GithubApi,
    userId: string,
    userToken: string,
  ): Promise<GithubConnectionRecord> {
    const user = await api.readUser(userToken);
    const repositories: LinkedGithubRepository[] = [];
    for (const installationId of await api.listUserInstallationIds(userToken)) {
      const reachable = await api.listUserInstallationRepositories(userToken, installationId);
      repositories.push(
        ...reachable
          .filter((repository) => repository.canPush)
          .map((repository) => toLinkedRepository(repository, installationId)),
      );
    }
    this.#warnOfUnusableDefaultBranches(userId, repositories);
    return {
      userId,
      githubUserId: user.id,
      login: user.login,
      name: user.name,
      connectedAt: this.#options.clock(),
      repositories: repositories.sort((first, second) =>
        first.fullName.localeCompare(second.fullName),
      ),
    };
  }

  /**
   * A repository whose default branch is not a name Barrack accepts (one
   * with a control character in it, or longer than 255 characters) is still
   * linked: a thread can start from it on a base branch the user names, and
   * starting from its default branch is refused, saying so.
   */
  #warnOfUnusableDefaultBranches(userId: string, repositories: LinkedGithubRepository[]): void {
    const unusable = repositories.filter(
      (repository) => !branchNameSchema.safeParse(repository.defaultBranch).success,
    );
    if (unusable.length > 0) {
      this.#options.logger.warn(
        { userId, repositories: unusable.map((repository) => repository.fullName) },
        "Linked repositories whose default branch Barrack cannot use; threads on them must name a base branch",
      );
    }
  }

  #describeConnected(connection: GithubConnectionRecord): GithubConnection {
    return {
      state: "connected",
      login: connection.login,
      connectedAt: connection.connectedAt.toISOString(),
      installUrl: this.installUrl,
      repositories: connection.repositories.map((repository) => ({
        fullName: repository.fullName,
        url: repository.cloneUrl,
        defaultBranch: repository.defaultBranch,
        isPrivate: repository.isPrivate,
      })),
    };
  }
}

function toLinkedRepository(
  repository: GithubRepository,
  installationId: number,
): LinkedGithubRepository {
  return {
    id: repository.id,
    fullName: repository.fullName,
    installationId,
    defaultBranch: repository.defaultBranch,
    cloneUrl: repository.cloneUrl,
    htmlUrl: repository.htmlUrl,
    isPrivate: repository.isPrivate,
  };
}

function digestOf(state: string): Buffer {
  return createHash("sha256").update(state).digest();
}

function refuse(reason: "attempt_not_valid" | "github_refused", message: string): FinishOutcome {
  return { ok: false, reason, message };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "GitHub could not be reached.";
}
