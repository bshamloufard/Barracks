import { SignJWT } from "jose";
import { z } from "zod";
import type { GithubAppSettings } from "./github-settings.js";

/**
 * The few GitHub endpoints Barrack calls, as its GitHub App or with a
 * user's short-lived token. Every answer is checked against what Barrack
 * expects before it is used; tokens are returned to the caller and never
 * logged or kept here.
 *
 * https://docs.github.com/en/rest/apps/apps
 * https://docs.github.com/en/rest/apps/installations
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
 */

/** The REST API version Barrack was written against. */
const apiVersion = "2026-03-10";
const requestTimeoutInMilliseconds = 15_000;
/** GitHub allows ten minutes; nine leaves room for clocks that differ a little. */
const appTokenLifetimeInSeconds = 9 * 60;
/** GitHub's advice: issued a minute in the past, against clock drift. */
const appTokenBackdatingInSeconds = 60;
const maximumPageSize = 100;
/** No user is verified for more repositories than this; more pages are not read. */
const maximumPages = 20;

export type RepositoryPermissions = Partial<
  Record<"contents" | "pull_requests" | "metadata", "read" | "write">
>;

export type InstallationToken = { token: string; expiresAt: Date };

export type GithubUser = { id: number; login: string; name: string | undefined };

export type GithubRepository = {
  id: number;
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
  canPush: boolean;
};

export type PullRequest = { number: number; url: string };

/** GitHub answered with an error, or with something Barrack cannot use. */
export class GithubApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
  }
}

const installationTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }),
  permissions: z.record(z.string(), z.string()).optional(),
  repositories: z.array(z.object({ id: z.number() })).optional(),
});

const userTokenSchema = z.object({ access_token: z.string().min(1) });

const userSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  name: z.string().nullish(),
});

const installationsPageSchema = z.object({
  total_count: z.number(),
  installations: z.array(z.object({ id: z.number().int().positive() })),
});

const repositoriesPageSchema = z.object({
  total_count: z.number(),
  repositories: z.array(
    z.object({
      id: z.number().int().positive(),
      full_name: z.string().min(3),
      clone_url: z.string().min(1),
      html_url: z.string().min(1),
      default_branch: z.string().min(1),
      private: z.boolean(),
      permissions: z.object({ push: z.boolean() }).optional(),
    }),
  ),
});

const collaboratorPermissionSchema = z.object({
  permission: z.string(),
  user: z
    .object({ permissions: z.object({ pull: z.boolean(), push: z.boolean() }).optional() })
    .nullish(),
});

const pullRequestSchema = z.object({ number: z.number().int().positive(), html_url: z.url() });

export type GithubApiOptions = {
  app: GithubAppSettings;
  webUrl: string;
  apiUrl: string;
};

export class GithubApi {
  readonly #options: GithubApiOptions;
  #appToken: { token: string; renewAfter: number } | undefined;

  constructor(options: GithubApiOptions) {
    this.#options = options;
  }

  /**
   * A token of the App's installation for one repository, with exactly the
   * permissions asked for. GitHub may add `metadata: read`, which every
   * token has; an answer granting anything else, or another repository,
   * is refused rather than handed on.
   */
  async createInstallationToken(
    installationId: number,
    repositoryId: number,
    permissions: RepositoryPermissions,
  ): Promise<InstallationToken> {
    const answer = await this.#request(
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      await this.#appAuthorization(),
      { repository_ids: [repositoryId], permissions },
    );
    const parsed = parseAnswer(installationTokenSchema, answer, "an installation token");
    assertGrantedOnlyAsked(parsed.permissions ?? {}, permissions);
    // GitHub lists the repositories a restricted token covers; one that
    // lists any other is refused. (An answer without the list is taken at
    // its word: GitHub grants no more than the request names.)
    const { repositories } = parsed;
    if (
      repositories !== undefined &&
      (repositories.length !== 1 || repositories[0]?.id !== repositoryId)
    ) {
      throw new GithubApiError(
        "GitHub granted a token for other repositories than the one asked for.",
      );
    }
    return { token: parsed.token, expiresAt: new Date(parsed.expires_at) };
  }

  /** Ends an installation token before it expires; https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token */
  async revokeInstallationToken(token: string): Promise<void> {
    await this.#request("DELETE", "/installation/token", `Bearer ${token}`);
  }

  /** Exchanges the code GitHub gave the user's browser for a user token, with PKCE. */
  async exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<string> {
    const { clientId, clientSecret } = this.#options.app;
    const response = await fetchWithTimeout(`${this.#options.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: codeVerifier,
      }),
    });
    // GitHub reports a bad or used code with status 200 and an `error` field.
    const answer: unknown = await response.json().catch(() => undefined);
    const parsed = userTokenSchema.safeParse(answer);
    if (!response.ok || !parsed.success) {
      throw new GithubApiError(
        "GitHub did not accept the sign-in code; it may have expired or been used already.",
        response.status,
      );
    }
    return parsed.data.access_token;
  }

  /** Ends a user's token once Barrack has read what it needed with it. */
  async revokeUserToken(userToken: string): Promise<void> {
    const { clientId, clientSecret } = this.#options.app;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    await this.#request(
      "DELETE",
      `/applications/${encodeURIComponent(clientId)}/token`,
      `Basic ${basic}`,
      {
        access_token: userToken,
      },
    );
  }

  async readUser(userToken: string): Promise<GithubUser> {
    const answer = await this.#request("GET", "/user", `Bearer ${userToken}`);
    const user = parseAnswer(userSchema, answer, "the user");
    return { id: user.id, login: user.login, name: user.name ?? undefined };
  }

  /** The App's installations the user can reach; GitHub lists only this App's for its user tokens. */
  async listUserInstallationIds(userToken: string): Promise<number[]> {
    const installationIds: number[] = [];
    for (let page = 1; page <= maximumPages; page += 1) {
      const answer = await this.#request(
        "GET",
        `/user/installations?per_page=${maximumPageSize}&page=${page}`,
        `Bearer ${userToken}`,
      );
      const parsed = parseAnswer(installationsPageSchema, answer, "the user's installations");
      installationIds.push(...parsed.installations.map((installation) => installation.id));
      if (parsed.installations.length < maximumPageSize) {
        break;
      }
    }
    return installationIds;
  }

  /** The repositories of one installation the user can reach, with whether they can push. */
  async listUserInstallationRepositories(
    userToken: string,
    installationId: number,
  ): Promise<GithubRepository[]> {
    const repositories: GithubRepository[] = [];
    for (let page = 1; page <= maximumPages; page += 1) {
      const answer = await this.#request(
        "GET",
        `/user/installations/${installationId}/repositories?per_page=${maximumPageSize}&page=${page}`,
        `Bearer ${userToken}`,
      );
      const parsed = parseAnswer(repositoriesPageSchema, answer, "the installation's repositories");
      repositories.push(
        ...parsed.repositories.map((repository) => ({
          id: repository.id,
          fullName: repository.full_name,
          cloneUrl: repository.clone_url,
          htmlUrl: repository.html_url,
          defaultBranch: repository.default_branch,
          isPrivate: repository.private,
          canPush: repository.permissions?.push ?? false,
        })),
      );
      if (parsed.repositories.length < maximumPageSize) {
        break;
      }
    }
    return repositories;
  }

  /**
   * Whether `login` can read and push to the repository today, asked with
   * an installation token (which needs only `metadata: read`). GitHub
   * answers 404 for a user who has no access at all.
   * https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user
   */
  async readUserPermission(
    installationToken: string,
    fullName: string,
    login: string,
  ): Promise<{ canRead: boolean; canPush: boolean }> {
    const answer = await this.#request(
      "GET",
      `/repos/${fullName}/collaborators/${encodeURIComponent(login)}/permission`,
      `Bearer ${installationToken}`,
    );
    const parsed = parseAnswer(collaboratorPermissionSchema, answer, "the user's permission");
    const permissions = parsed.user?.permissions;
    return {
      canRead:
        permissions?.pull ??
        ["admin", "maintain", "write", "triage", "read"].includes(parsed.permission),
      canPush: permissions?.push ?? ["admin", "maintain", "write"].includes(parsed.permission),
    };
  }

  /**
   * Opens a pull request from `head` into `base`. If GitHub says one is
   * already open for that branch (a publication that opened it but could
   * not record it), that one is returned instead of a second.
   */
  async openPullRequest(
    installationToken: string,
    fullName: string,
    pullRequest: { title: string; body: string; head: string; base: string },
  ): Promise<{ pullRequest: PullRequest; isNew: boolean }> {
    try {
      const answer = await this.#request(
        "POST",
        `/repos/${fullName}/pulls`,
        `Bearer ${installationToken}`,
        pullRequest,
      );
      return { pullRequest: toPullRequest(answer), isNew: true };
    } catch (error) {
      if (!(error instanceof GithubApiError) || error.status !== 422) {
        throw error;
      }
      const existing = await this.#findOpenPullRequest(
        installationToken,
        fullName,
        pullRequest.head,
      );
      if (existing === undefined) {
        throw error;
      }
      return { pullRequest: existing, isNew: false };
    }
  }

  async #findOpenPullRequest(
    installationToken: string,
    fullName: string,
    head: string,
  ): Promise<PullRequest | undefined> {
    const [owner] = fullName.split("/");
    const query = new URLSearchParams({ head: `${owner}:${head}`, state: "open" });
    const answer = await this.#request(
      "GET",
      `/repos/${fullName}/pulls?${query.toString()}`,
      `Bearer ${installationToken}`,
    );
    const [first] = parseAnswer(z.array(pullRequestSchema), answer, "the open pull requests");
    return first === undefined ? undefined : { number: first.number, url: first.html_url };
  }

  /** A JSON Web Token signed with the App's key, reused until a minute before it expires. */
  async #appAuthorization(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.#appToken !== undefined && now < this.#appToken.renewAfter) {
      return `Bearer ${this.#appToken.token}`;
    }
    const { clientId, privateKey } = this.#options.app;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(clientId)
      .setIssuedAt(now - appTokenBackdatingInSeconds)
      .setExpirationTime(now + appTokenLifetimeInSeconds)
      .sign(privateKey);
    this.#appToken = { token, renewAfter: now + appTokenLifetimeInSeconds - 60 };
    return `Bearer ${token}`;
  }

  async #request(
    method: string,
    path: string,
    authorization: string,
    body?: object,
  ): Promise<unknown> {
    const response = await fetchWithTimeout(`${this.#options.apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: authorization,
        "X-GitHub-Api-Version": apiVersion,
        "User-Agent": "Barrack",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new GithubApiError(await describeRefusal(method, path, response), response.status);
    }
    return response.status === 204 ? undefined : response.json();
  }
}

/** Requested permissions may come back with `metadata: read` added; anything more is refused. */
function assertGrantedOnlyAsked(
  granted: Record<string, string>,
  requested: RepositoryPermissions,
): void {
  for (const [permission, level] of Object.entries(granted)) {
    const requestedLevel = requested[permission as keyof RepositoryPermissions];
    const isImplicitMetadata = permission === "metadata" && level === "read";
    if (requestedLevel !== level && !isImplicitMetadata) {
      throw new GithubApiError(
        `GitHub granted a token with ${permission}: ${level}, which was not asked for.`,
      );
    }
  }
}

function toPullRequest(answer: unknown): PullRequest {
  const parsed = parseAnswer(pullRequestSchema, answer, "the pull request");
  return { number: parsed.number, url: parsed.html_url };
}

function parseAnswer<Answer>(schema: z.ZodType<Answer>, answer: unknown, what: string): Answer {
  const parsed = schema.safeParse(answer);
  if (!parsed.success) {
    throw new GithubApiError(`GitHub answered with something unexpected for ${what}.`);
  }
  return parsed.data;
}

/** GitHub's own `message`, which never echoes a token; at most a line of it. */
async function describeRefusal(method: string, path: string, response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const message =
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
      ? body.message.slice(0, 300)
      : response.statusText;
  const route = path.split("?")[0];
  return `GitHub refused ${method} ${route} with HTTP ${response.status}: ${message}`;
}

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutInMilliseconds) });
}
