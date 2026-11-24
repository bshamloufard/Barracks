import type { GithubApi } from "../github/github-api.js";
import type {
  GithubConnectionRecord,
  GithubConnectionStore,
} from "../github/github-connection-store.js";
import { checkLiveRepositoryAccess } from "../github/live-repository-access.js";
import type { Logger } from "../logger.js";
import type { Clock } from "../sandbox-lifecycle/lifecycle-settings.js";
import type { ThreadStore } from "../threads/thread-store.js";
import type {
  GithubRepositoryReference,
  ThreadRepositoryStore,
} from "./thread-repository-store.js";

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

/**
 * After GitHub refuses to mint a token for a thread (the App was removed
 * from the repository, say), it is not asked again for that thread for
 * this long: a sandbox asking at its rate limit would otherwise spend the
 * installation's GitHub API allowance, shared by all its users, on
 * refusals.
 */
const refusedMintBackoffInMilliseconds = 60_000;

/** A token handed out again while GitHub cannot be asked must still be good for this long. */
const lastingTokenMarginInMilliseconds = 60_000;

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
type MintOutcome = { token: CachedToken } | { refusal: string };
/** `isRefusing` notes that the last request was refused, so a flood is logged once, not per request. */
type Allowance = { remaining: number; refilledAt: number; isRefusing: boolean };

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
 * that is why nothing that can write ever goes this way.
 *
 * Each request is checked against the thread owner's GitHub link, and before
 * every token is minted (about twice an hour while a sandbox is busy) GitHub
 * is asked whether the App still reaches the repository and the owner can
 * still read it. When GitHub says no, the token handed out last is revoked
 * and the request refused, saying why: the agent keeps working on what it
 * has, but can fetch nothing more, and publishing is refused too. When
 * GitHub cannot be asked, no token is minted (nothing is assumed), but the
 * token handed out last, which the sandbox holds anyway, is handed out again
 * while it lasts, so a short outage does not stop a working thread.
 */
export class RepositoryCredentials {
  readonly #options: RepositoryCredentialsOptions;
  readonly #limits: CredentialRequestLimits;
  readonly #cachedTokens = new Map<string, CachedToken>();
  readonly #mintsUnderWay = new Map<string, Promise<MintOutcome>>();
  readonly #allowances = new Map<string, Allowance>();
  /** Until when GitHub is not asked again for a thread whose last mint was refused, and why. */
  readonly #mintRefusals = new Map<string, { until: number; reason: string }>();

  constructor(options: RepositoryCredentialsOptions) {
    this.#options = options;
    this.#limits = options.limits ?? defaultCredentialRequestLimits;
  }

  async issue(threadId: string): Promise<CredentialOutcome> {
    if (!this.#takeAllowance(threadId)) {
      return refuse(
        "This sandbox asked for repository credentials too often; wait a moment and try again.",
      );
    }
    const repository = await this.#options.repositories.find(threadId);
    const github = repository?.github;
    if (repository?.access !== "github_app" || github === undefined) {
      return refuse("This thread's repository is public; it needs no credentials.");
    }
    const linked = await this.#findOwnerLink(threadId, github.repositoryId);
    if ("problem" in linked) {
      this.#withdrawToken(threadId);
      return refuse(linked.problem);
    }
    const outcome = await this.#freshToken(threadId, linked.connection, github);
    if ("refusal" in outcome) {
      return refuse(outcome.refusal);
    }
    return {
      isGranted: true,
      username: installationTokenUserName,
      password: outcome.token.token,
      expiresAt: outcome.token.expiresAt,
    };
  }

  /** Forgets everything kept for a thread, such as when it is deleted. */
  forgetThread(threadId: string): void {
    this.#cachedTokens.delete(threadId);
    this.#allowances.delete(threadId);
    this.#mintRefusals.delete(threadId);
  }

  async #findOwnerLink(
    threadId: string,
    repositoryId: number,
  ): Promise<{ connection: GithubConnectionRecord } | { problem: string }> {
    const ownerUserId = (await this.#options.threadStore.find(threadId))?.ownerUserId;
    const connection =
      ownerUserId === undefined ? undefined : await this.#options.connections.find(ownerUserId);
    if (connection === undefined) {
      return {
        problem:
          "The thread's owner has disconnected GitHub from Barrack, so the repository can no longer be read.",
      };
    }
    if (!connection.repositories.some((repository) => repository.id === repositoryId)) {
      return {
        problem: "The thread's owner is no longer verified to have access to this repository.",
      };
    }
    return { connection };
  }

  /** A cached token with enough life left, or one minted now; at most one mint per thread at a time. */
  async #freshToken(
    threadId: string,
    connection: GithubConnectionRecord,
    github: GithubRepositoryReference,
  ): Promise<MintOutcome> {
    const cached = this.#cachedTokens.get(threadId);
    const now = this.#options.clock().getTime();
    if (
      cached !== undefined &&
      cached.expiresAt.getTime() - now > minimumRemainingLifetimeInMilliseconds
    ) {
      return { token: cached };
    }
    const underWay = this.#mintsUnderWay.get(threadId);
    if (underWay !== undefined) {
      return underWay;
    }
    const refused = this.#mintRefusals.get(threadId);
    if (refused !== undefined && now < refused.until) {
      return this.#cachedWhileItLasts(threadId) ?? { refusal: refused.reason };
    }
    const mint = this.#checkAccessAndMint(threadId, connection, github).finally(() =>
      this.#mintsUnderWay.delete(threadId),
    );
    this.#mintsUnderWay.set(threadId, mint);
    return mint;
  }

  async #checkAccessAndMint(
    threadId: string,
    connection: GithubConnectionRecord,
    github: GithubRepositoryReference,
  ): Promise<MintOutcome> {
    const api = this.#options.api;
    if (api === undefined) {
      return { refusal: "There is no GitHub App to mint a token with." };
    }
    const access = await checkLiveRepositoryAccess(
      api,
      connection,
      { id: github.repositoryId, installationId: github.installationId, fullName: github.fullName },
      "read",
    );
    if (!access.ok) {
      return this.#refuseMint(threadId, access.reason, access.isCertain);
    }
    let token: CachedToken;
    try {
      token = await api.createInstallationToken(github.installationId, github.repositoryId, {
        contents: "read",
      });
    } catch (error) {
      this.#options.logger.warn({ err: error, threadId }, "Could not mint a read-only token");
      return this.#refuseMint(
        threadId,
        `GitHub would not give Barrack's App access to ${github.fullName}; the App may no longer be installed on it.`,
        false,
      );
    }
    this.#mintRefusals.delete(threadId);
    this.#cachedTokens.set(threadId, token);
    this.#options.logger.info(
      { threadId, expiresAt: token.expiresAt.toISOString() },
      "Minted a read-only token for the thread's repository",
    );
    return { token };
  }

  /**
   * Not asked again for a minute. When GitHub said the access has gone, the
   * token handed out last is withdrawn; when it could not be asked, that
   * token is handed out again while it lasts.
   */
  #refuseMint(threadId: string, reason: string, isAccessGone: boolean): MintOutcome {
    this.#mintRefusals.set(threadId, {
      until: this.#options.clock().getTime() + refusedMintBackoffInMilliseconds,
      reason,
    });
    this.#options.logger.warn(
      { threadId, reason, isAccessGone },
      "Refused to mint a read-only token for the thread's repository",
    );
    if (isAccessGone) {
      this.#withdrawToken(threadId);
      return { refusal: reason };
    }
    return this.#cachedWhileItLasts(threadId) ?? { refusal: reason };
  }

  #cachedWhileItLasts(threadId: string): MintOutcome | undefined {
    const cached = this.#cachedTokens.get(threadId);
    const now = this.#options.clock().getTime();
    return cached !== undefined &&
      cached.expiresAt.getTime() - now > lastingTokenMarginInMilliseconds
      ? { token: cached }
      : undefined;
  }

  /** Forgets the thread's token and asks GitHub to end it, so access lost is lost at once. */
  #withdrawToken(threadId: string): void {
    const cached = this.#cachedTokens.get(threadId);
    this.#cachedTokens.delete(threadId);
    if (cached === undefined || this.#options.api === undefined) {
      return;
    }
    this.#options.api.revokeInstallationToken(cached.token).catch((error: unknown) => {
      this.#options.logger.warn(
        { err: error, threadId },
        "Could not revoke a read-only token whose access has gone; it expires within the hour",
      );
    });
  }

  #takeAllowance(threadId: string): boolean {
    const now = this.#options.clock().getTime();
    const { burst, refillIntervalInMilliseconds } = this.#limits;
    const allowance = this.#allowances.get(threadId) ?? {
      remaining: burst,
      refilledAt: now,
      isRefusing: false,
    };
    const refills = Math.floor((now - allowance.refilledAt) / refillIntervalInMilliseconds);
    const remaining = Math.min(burst, allowance.remaining + refills);
    const refilledAt =
      remaining === burst ? now : allowance.refilledAt + refills * refillIntervalInMilliseconds;
    if (remaining === 0) {
      if (!allowance.isRefusing) {
        this.#options.logger.warn(
          { threadId },
          "Refusing credential requests over the rate limit until it refills",
        );
      }
      this.#allowances.set(threadId, { remaining, refilledAt, isRefusing: true });
      return false;
    }
    this.#allowances.set(threadId, { remaining: remaining - 1, refilledAt, isRefusing: false });
    return true;
  }
}

function refuse(reason: string): CredentialOutcome {
  return { isGranted: false, reason };
}
