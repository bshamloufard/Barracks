import type { GithubApi } from "../github/github-api.js";
import type { GithubConnectionStore } from "../github/github-connection-store.js";
import type { Logger } from "../logger.js";
import type { Clock } from "../sandbox-lifecycle/lifecycle-settings.js";
import type { ThreadStore } from "../threads/thread-store.js";
import type { ThreadRepositoryStore } from "./thread-repository-store.js";

export type CredentialOutcome =
  | { isGranted: true; username: string; password: string; expiresAt: Date }
  | { isGranted: false; reason: string };

/**
 * How often one sandbox may ask: a burst of `burst`, then one every
 * `refillIntervalInMilliseconds`. Git asks once per operation that reaches
 * the repository, and a partial clone also asks each time it fetches
 * contents it lacks, so a busy agent asks often; tokens are reused, so
 * asking costs GitHub nothing until one nears expiry.
 */
export type CredentialRequestLimits = {
  burst: number;
  refillIntervalInMilliseconds: number;
};

export const defaultCredentialRequestLimits: CredentialRequestLimits = {
  burst: 30,
  refillIntervalInMilliseconds: 2_000,
};

/**
 * A token is reused until this long before it expires, so that Git never
 * starts a long fetch with one about to stop working. GitHub's tokens last
 * an hour, so a busy sandbox causes about two mints an hour.
 */
const minimumRemainingLifetimeInMilliseconds = 15 * 60_000;

/** GitHub's documented user name for an installation token over HTTPS. */
const installationTokenUserName = "x-access-token";

export type RepositoryCredentialsOptions = {
  threadStore: ThreadStore;
  repositories: ThreadRepositoryStore;
  connections: GithubConnectionStore;
  api: GithubApi | undefined;
  clock: Clock;
  logger: Logger;
  limits?: CredentialRequestLimits;
};

type CachedToken = { token: string; expiresAt: Date };
type Allowance = { remaining: number; refilledAt: number };

/**
 * Answers a sandbox's requests for credentials to read its thread's
 * repository. Which repository is decided by the thread alone (the
 * supervisor's connection is authenticated for exactly one thread), never by
 * anything the request says, so no sandbox can obtain access to another
 * thread's repository.
 *
 * What is handed out is a GitHub App installation token restricted to that
 * one repository and to reading its contents. The agent can ask through the
 * same helper Git uses, so it must be assumed to hold whatever is returned;
 * that is why nothing that can write ever goes this way. Each request is
 * checked against the thread owner's GitHub link, so a user who disconnects
 * GitHub, or reconnects without the repository, stops their sandboxes
 * getting new tokens; a token already handed out lasts until it expires.
 */
export class RepositoryCredentials {
  readonly #options: RepositoryCredentialsOptions;
  readonly #limits: CredentialRequestLimits;
  readonly #cachedTokens = new Map<string, CachedToken>();
  readonly #mintsUnderWay = new Map<string, Promise<CachedToken>>();
  readonly #allowances = new Map<string, Allowance>();

  constructor(options: RepositoryCredentialsOptions) {
    this.#options = options;
    this.#limits = options.limits ?? defaultCredentialRequestLimits;
  }

  async issue(threadId: string): Promise<CredentialOutcome> {
    if (!this.#takeAllowance(threadId)) {
      this.#options.logger.warn({ threadId }, "Refused a credential request over the rate limit");
      return refuse(
        "This sandbox asked for repository credentials too often; wait a moment and try again.",
      );
    }
    const repository = await this.#options.repositories.find(threadId);
    const github = repository?.github;
    if (repository?.access !== "github_app" || github === undefined) {
      return refuse("This thread's repository is public; it needs no credentials.");
    }
    const linkProblem = await this.#checkOwnerLink(threadId, github.repositoryId);
    if (linkProblem !== undefined) {
      return refuse(linkProblem);
    }
    try {
      const token = await this.#freshToken(threadId, github.installationId, github.repositoryId);
      return {
        isGranted: true,
        username: installationTokenUserName,
        password: token.token,
        expiresAt: token.expiresAt,
      };
    } catch (error) {
      this.#options.logger.warn(
        { err: error, threadId },
        "Could not mint a read-only repository token",
      );
      return refuse(
        `GitHub would not give Barrack's App access to ${github.fullName}; the App may no longer be installed on it.`,
      );
    }
  }

  /** Forgets everything kept for a thread, such as when it is deleted. */
  forgetThread(threadId: string): void {
    this.#cachedTokens.delete(threadId);
    this.#allowances.delete(threadId);
  }

  async #checkOwnerLink(threadId: string, repositoryId: number): Promise<string | undefined> {
    const ownerUserId = (await this.#options.threadStore.find(threadId))?.ownerUserId;
    const connection =
      ownerUserId === undefined ? undefined : await this.#options.connections.find(ownerUserId);
    if (connection === undefined) {
      return "The thread's owner has disconnected GitHub from Barrack, so the repository can no longer be read.";
    }
    if (!connection.repositories.some((repository) => repository.id === repositoryId)) {
      return "The thread's owner is no longer verified to have access to this repository.";
    }
    return undefined;
  }

  /** A cached token with enough life left, or one minted now; at most one mint per thread at a time. */
  async #freshToken(
    threadId: string,
    installationId: number,
    repositoryId: number,
  ): Promise<CachedToken> {
    const cached = this.#cachedTokens.get(threadId);
    const now = this.#options.clock().getTime();
    if (
      cached !== undefined &&
      cached.expiresAt.getTime() - now > minimumRemainingLifetimeInMilliseconds
    ) {
      return cached;
    }
    const underWay = this.#mintsUnderWay.get(threadId);
    if (underWay !== undefined) {
      return underWay;
    }
    const mint = this.#mint(threadId, installationId, repositoryId).finally(() =>
      this.#mintsUnderWay.delete(threadId),
    );
    this.#mintsUnderWay.set(threadId, mint);
    return mint;
  }

  async #mint(
    threadId: string,
    installationId: number,
    repositoryId: number,
  ): Promise<CachedToken> {
    const api = this.#options.api;
    if (api === undefined) {
      throw new Error("There is no GitHub App to mint a token with.");
    }
    const token = await api.createInstallationToken(installationId, repositoryId, {
      contents: "read",
    });
    this.#cachedTokens.set(threadId, token);
    this.#options.logger.info(
      { threadId, expiresAt: token.expiresAt.toISOString() },
      "Minted a read-only token for the thread's repository",
    );
    return token;
  }

  #takeAllowance(threadId: string): boolean {
    const now = this.#options.clock().getTime();
    const { burst, refillIntervalInMilliseconds } = this.#limits;
    const allowance = this.#allowances.get(threadId) ?? { remaining: burst, refilledAt: now };
    const refills = Math.floor((now - allowance.refilledAt) / refillIntervalInMilliseconds);
    const remaining = Math.min(burst, allowance.remaining + refills);
    const refilledAt =
      remaining === burst ? now : allowance.refilledAt + refills * refillIntervalInMilliseconds;
    if (remaining === 0) {
      this.#allowances.set(threadId, { remaining, refilledAt });
      return false;
    }
    this.#allowances.set(threadId, { remaining: remaining - 1, refilledAt });
    return true;
  }
}

function refuse(reason: string): CredentialOutcome {
  return { isGranted: false, reason };
}
