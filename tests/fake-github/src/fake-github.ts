import { createHash, generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { jwtVerify } from "jose";
import { serveGitRequest } from "./git-http-backend.js";
import { createBareRepository, type ObjectFormat, readBranch } from "./local-repositories.js";

export {
  pushCommitAsSomeoneElse,
  readAuthor,
  readBranch,
  readCommitSubjects,
  runGit,
} from "./local-repositories.js";

/**
 * A stand-in for GitHub, for tests: the REST and OAuth endpoints Barrack
 * calls, answering as GitHub documents them, and Git repositories over
 * smart HTTP that check tokens the way GitHub does. It records every
 * request, so a test can say exactly what Barrack asked.
 *
 * - Installation tokens carry the repositories and permissions asked for,
 *   and Git honours them: a token can read only its repositories, and push
 *   only with `contents: write`.
 * - Users have push or read access to repositories; the App is installed on
 *   some of them; signing in hands out codes bound to a PKCE challenge.
 * - The web pages (`webUrl`) and the API (`apiUrl`) share one server, the
 *   API under `/api`, as GitHub Enterprise lays them out.
 */

export type FakeRepository = {
  id: number;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** The bare repository on disk. */
  directory: string;
  cloneUrl: string;
  htmlUrl: string;
};

export type FakeGithubUser = { id: number; login: string; name: string | undefined };

export type IssuedToken = {
  token: string;
  installationId: number;
  repositoryIds: number[];
  permissions: Permissions;
  isRevoked: boolean;
};

export type RecordedRequest = {
  method: string;
  path: string;
  /** What kind of credential it carried. */
  credential: "app" | "installation" | "user" | "client" | "none";
  status: number;
};

export type FakePullRequest = {
  repositoryId: number;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  url: string;
};

/** What the endpoints read from a request's JSON body; anything may be missing or of another type. */
type RequestFields = {
  code?: unknown;
  code_verifier?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
  repository_ids?: unknown;
  permissions?: unknown;
  access_token?: unknown;
  head?: unknown;
  title?: unknown;
  body?: unknown;
  base?: unknown;
};

type Permissions = {
  contents?: string;
  pull_requests?: string;
  metadata?: string;
  [permission: string]: string | undefined;
};

type UserRecord = FakeGithubUser & {
  pushRepositoryIds: Set<number>;
  readRepositoryIds: Set<number>;
};
type CodeRecord = { login: string; codeChallenge: string | undefined };
type GitRequestKind = "fetch" | "push";
type HeldGitRequest = { reached: PromiseWithResolvers<void>; released: Promise<void> };
type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

const appPermissions: Permissions = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
};
const permissionRank: Record<string, number> = { read: 1, write: 2 };

export type FakeGithubOptions = {
  /** The address to listen on; Docker tests use the bridge's gateway so sandboxes can reach it. */
  host?: string;
};

export class FakeGithub {
  readonly webUrl: string;
  readonly apiUrl: string;
  /** The App's settings, as an operator would give them to Barrack. */
  readonly clientId = "Iv1.fakeclientid";
  readonly clientSecret = "fake-client-secret";
  readonly slug = "barrack-test";
  readonly privateKeyPem: string;
  readonly requests: RecordedRequest[] = [];
  readonly pullRequests: FakePullRequest[] = [];
  readonly issuedTokens: IssuedToken[] = [];
  readonly #publicKey: KeyObject;
  readonly #server: Server;
  readonly #repositoriesDirectory: string;
  readonly #repositories: FakeRepository[] = [];
  readonly #users = new Map<string, UserRecord>();
  readonly #installations = new Map<number, Set<number>>();
  readonly #codes = new Map<string, CodeRecord>();
  readonly #userTokens = new Map<string, string>();
  readonly #heldGitRequests = new Map<GitRequestKind, HeldGitRequest>();
  #isApiDown = false;
  #nextIdentifier = 1000;

  private constructor(server: Server, baseUrl: string, repositoriesDirectory: string) {
    this.#server = server;
    this.webUrl = baseUrl;
    this.apiUrl = `${baseUrl}/api`;
    this.#repositoriesDirectory = repositoriesDirectory;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    this.#publicKey = publicKey;
  }

  static async start(options: FakeGithubOptions = {}): Promise<FakeGithub> {
    const repositoriesDirectory = await mkdtemp(path.join(tmpdir(), "barrack-fake-github-"));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, options.host ?? "127.0.0.1", resolve));
    const { address, port } = server.address() as AddressInfo;
    const fake = new FakeGithub(server, `http://${address}:${port}`, repositoriesDirectory);
    server.on("request", (request, response) => {
      fake.#handle(request, response).catch(() => {
        response.statusCode = 500;
        response.end();
      });
    });
    return fake;
  }

  /** The variables that point a control plane at this fake, with its App configured. */
  controlPlaneEnvironment(): Record<string, string> {
    return {
      BARRACK_GITHUB_APP_CLIENT_ID: this.clientId,
      BARRACK_GITHUB_APP_CLIENT_SECRET: this.clientSecret,
      BARRACK_GITHUB_APP_PRIVATE_KEY: this.privateKeyPem,
      BARRACK_GITHUB_APP_SLUG: this.slug,
      BARRACK_GITHUB_URL: this.webUrl,
      BARRACK_GITHUB_API_URL: this.apiUrl,
      BARRACK_ALLOW_PLAIN_HTTP_REPOSITORIES: "development-only",
    };
  }

  async createRepository(options: {
    owner: string;
    name: string;
    isPrivate: boolean;
    defaultBranch?: string;
    files?: Record<string, string>;
    /** SHA-1 unless given; GitHub hosts no SHA-256 repository, but other hosts can. */
    objectFormat?: ObjectFormat;
  }): Promise<FakeRepository> {
    const fullName = `${options.owner}/${options.name}`;
    const directory = path.join(this.#repositoriesDirectory, `${fullName}.git`);
    const defaultBranch = options.defaultBranch ?? "main";
    await createBareRepository(
      directory,
      defaultBranch,
      options.files ?? { "README.md": `# ${options.name}\n` },
      options.objectFormat,
    );
    const repository: FakeRepository = {
      id: this.#mintIdentifier(),
      fullName,
      isPrivate: options.isPrivate,
      defaultBranch,
      directory,
      cloneUrl: `${this.webUrl}/${fullName}.git`,
      htmlUrl: `${this.webUrl}/${fullName}`,
    };
    this.#repositories.push(repository);
    return repository;
  }

  addUser(user: {
    login: string;
    name?: string;
    push?: FakeRepository[];
    read?: FakeRepository[];
  }): FakeGithubUser {
    const record: UserRecord = {
      id: this.#mintIdentifier(),
      login: user.login,
      name: user.name,
      pushRepositoryIds: new Set((user.push ?? []).map((repository) => repository.id)),
      readRepositoryIds: new Set((user.read ?? []).map((repository) => repository.id)),
    };
    this.#users.set(user.login, record);
    return { id: record.id, login: record.login, name: record.name };
  }

  /** Takes away a user's push access, as a repository's owner might. */
  revokePush(login: string, repository: FakeRepository): void {
    this.#users.get(login)?.pushRepositoryIds.delete(repository.id);
  }

  /** Takes away all of a user's access, as removing them from an organisation does. */
  revokeAccess(login: string, repository: FakeRepository): void {
    this.revokePush(login, repository);
    this.#users.get(login)?.readRepositoryIds.delete(repository.id);
  }

  /** While down, every API request is answered 503, as during a GitHub outage; Git is unaffected. */
  setApiDown(isDown: boolean): void {
    this.#isApiDown = isDown;
  }

  /** Installs the App on these repositories; returns the installation's identifier. */
  installApp(repositories: FakeRepository[]): number {
    const installationId = this.#mintIdentifier();
    this.#installations.set(
      installationId,
      new Set(repositories.map((repository) => repository.id)),
    );
    return installationId;
  }

  removeFromInstallation(installationId: number, repository: FakeRepository): void {
    this.#installations.get(installationId)?.delete(repository.id);
  }

  addToInstallation(installationId: number, repository: FakeRepository): void {
    this.#installations.get(installationId)?.add(repository.id);
  }

  /**
   * What GitHub would put in the callback after the user approved the App:
   * a code for that user, bound to the PKCE challenge in the authorization
   * address Barrack sent the browser to.
   */
  approveAuthorization(login: string, authorizationUrl: string): { code: string; state: string } {
    const query = new URL(authorizationUrl).searchParams;
    if (query.get("client_id") !== this.clientId) {
      throw new Error("The authorization address names another App.");
    }
    const code = randomBytes(10).toString("hex");
    this.#codes.set(code, { login, codeChallenge: query.get("code_challenge") ?? undefined });
    return { code, state: query.get("state") ?? "" };
  }

  repositoryNamed(fullName: string): FakeRepository {
    const repository = this.#repositories.find((candidate) => candidate.fullName === fullName);
    if (repository === undefined) {
      throw new Error(`There is no repository ${fullName}.`);
    }
    return repository;
  }

  /**
   * Holds the next Git request of that kind (a fetch or clone, or a push)
   * until `release` is called, so a test can act while Git waits on the
   * server; `reached` resolves once the request has arrived.
   */
  holdNextGitRequest(kind: GitRequestKind): { reached: Promise<void>; release: () => void } {
    const reached = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    this.#heldGitRequests.set(kind, { reached, released: released.promise });
    return { reached: reached.promise, release: () => released.resolve() };
  }

  readBranch(repository: FakeRepository, branch: string): Promise<string | undefined> {
    return readBranch(repository.directory, branch);
  }

  /** A token for these repositories, as the App would mint, for tests of the Git server itself. */
  issueTokenForTest(repositories: FakeRepository[], permissions: Permissions): string {
    return this.#issueInstallationToken(
      0,
      repositories.map((repository) => repository.id),
      permissions,
    ).token;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    await rm(this.#repositoriesDirectory, { recursive: true, force: true });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.webUrl);
    if (/\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(url.pathname)) {
      await this.#handleGit(request, response, url);
      return;
    }
    const body = await readBody(request);
    const credential = this.#classifyCredential(request.headers.authorization);
    const answer = url.pathname.startsWith("/api/")
      ? await this.#answerApi(request.method ?? "GET", url, request.headers.authorization, body)
      : this.#answerWeb(request.method ?? "GET", url, body);
    this.requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      credential,
      status: answer.status,
    });
    response.writeHead(answer.status, { "Content-Type": "application/json", ...answer.headers });
    response.end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
  }

  async #handleGit(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const fullName = url.pathname.replace(/^\//, "").replace(/\.git\/.*$/, "");
    const repository = this.#repositories.find((candidate) => candidate.fullName === fullName);
    const isPush =
      url.searchParams.get("service") === "git-receive-pack" ||
      url.pathname.endsWith("/git-receive-pack");
    const held = this.#heldGitRequests.get(isPush ? "push" : "fetch");
    if (held !== undefined) {
      this.#heldGitRequests.delete(isPush ? "push" : "fetch");
      held.reached.resolve();
      await held.released;
    }
    const token = readBasicPassword(request.headers.authorization);
    const decision = this.#decideGitAccess(repository, isPush, token);
    this.requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      credential: token === undefined ? "none" : "installation",
      status: decision === "allowed" ? 200 : decision,
    });
    if (decision !== "allowed" || repository === undefined) {
      request.resume();
      const headers: Record<string, string> =
        decision === 401 ? { "WWW-Authenticate": 'Basic realm="GitHub"' } : {};
      response.writeHead(decision === "allowed" ? 404 : decision, headers);
      response.end();
      return;
    }
    serveGitRequest(
      request,
      response,
      this.#repositoriesDirectory,
      url,
      isPush ? "x-access-token" : undefined,
    );
  }

  /** GitHub's rules: public repositories read by anyone, everything else by token. */
  #decideGitAccess(
    repository: FakeRepository | undefined,
    isPush: boolean,
    token: string | undefined,
  ): "allowed" | 401 | 403 | 404 {
    if (repository === undefined) {
      return 404;
    }
    if (!isPush && !repository.isPrivate) {
      return "allowed";
    }
    if (token === undefined) {
      return 401;
    }
    const issued = this.issuedTokens.find(
      (candidate) => candidate.token === token && !candidate.isRevoked,
    );
    if (issued === undefined || !issued.repositoryIds.includes(repository.id)) {
      return repository.isPrivate && !isPush ? 404 : 403;
    }
    const contents = permissionRank[issued.permissions.contents ?? ""] ?? 0;
    if (contents < (isPush ? 2 : 1)) {
      return 403;
    }
    return "allowed";
  }

  #answerWeb(method: string, url: URL, body: unknown): Answer {
    if (method === "POST" && url.pathname === "/login/oauth/access_token") {
      return this.#exchangeCode(body);
    }
    return { status: 404, body: { message: "Not Found" } };
  }

  #exchangeCode(body: unknown): Answer {
    const fields = fieldsOf(body);
    const code = typeof fields.code === "string" ? fields.code : "";
    const record = this.#codes.get(code);
    this.#codes.delete(code);
    const challengeMatches =
      record?.codeChallenge === undefined ||
      createHash("sha256")
        .update(String(fields.code_verifier ?? ""))
        .digest("base64url") === record.codeChallenge;
    if (
      record === undefined ||
      fields.client_id !== this.clientId ||
      fields.client_secret !== this.clientSecret ||
      !challengeMatches
    ) {
      // GitHub answers a bad code with 200 and an error field.
      return { status: 200, body: { error: "bad_verification_code" } };
    }
    const accessToken = `ghu_${randomBytes(16).toString("hex")}`;
    this.#userTokens.set(accessToken, record.login);
    return { status: 200, body: { access_token: accessToken, token_type: "bearer", scope: "" } };
  }

  async #answerApi(
    method: string,
    url: URL,
    authorization: string | undefined,
    body: unknown,
  ): Promise<Answer> {
    if (this.#isApiDown) {
      return { status: 503, body: { message: "Service Unavailable" } };
    }
    const route = `${method} ${url.pathname.slice("/api".length)}`;
    const installationToken = route.match(/^POST \/app\/installations\/(\d+)\/access_tokens$/);
    if (installationToken !== null) {
      return this.#mintInstallationToken(Number(installationToken[1]), authorization, body);
    }
    if (route === "DELETE /installation/token") {
      return this.#revokeInstallationToken(authorization);
    }
    if (route === `DELETE /applications/${this.clientId}/token`) {
      return this.#revokeUserToken(authorization, body);
    }
    if (route.startsWith("GET /user")) {
      return this.#answerUser(route, url, authorization);
    }
    const collaborator = route.match(
      /^GET \/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/,
    );
    if (collaborator !== null) {
      return this.#answerPermission(collaborator[1] ?? "", collaborator[2] ?? "", authorization);
    }
    const pulls = route.match(/^(GET|POST) \/repos\/([^/]+\/[^/]+)\/pulls$/);
    if (pulls !== null) {
      return pulls[1] === "POST"
        ? this.#openPullRequest(pulls[2] ?? "", authorization, body)
        : this.#listPullRequests(pulls[2] ?? "", url, authorization);
    }
    return { status: 404, body: { message: "Not Found" } };
  }

  async #mintInstallationToken(
    installationId: number,
    authorization: string | undefined,
    body: unknown,
  ): Promise<Answer> {
    if (!(await this.#isAppToken(authorization))) {
      return { status: 401, body: { message: "A JSON web token could not be decoded" } };
    }
    const repositoryIds = this.#installations.get(installationId);
    if (repositoryIds === undefined) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const fields = fieldsOf(body);
    const askedIds = Array.isArray(fields.repository_ids)
      ? fields.repository_ids.map(Number)
      : [...repositoryIds];
    const askedPermissions: Permissions = isRecord(fields.permissions)
      ? (fields.permissions as Permissions)
      : appPermissions;
    if (!askedIds.every((id) => repositoryIds.has(id))) {
      return {
        status: 422,
        body: {
          message:
            "There is at least one repository that does not exist or is not accessible to the parent installation.",
        },
      };
    }
    for (const [permission, level = ""] of Object.entries(askedPermissions)) {
      if ((permissionRank[level] ?? 9) > (permissionRank[appPermissions[permission] ?? ""] ?? 0)) {
        return {
          status: 422,
          body: {
            message: `The permissions requested are not granted to this installation: ${permission}`,
          },
        };
      }
    }
    const issued = this.#issueInstallationToken(installationId, askedIds, {
      ...askedPermissions,
      metadata: "read",
    });
    return {
      status: 201,
      body: {
        token: issued.token,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: issued.permissions,
        repository_selection: "selected",
        repositories: askedIds.map((id) => ({ id })),
      },
    };
  }

  #issueInstallationToken(
    installationId: number,
    repositoryIds: number[],
    permissions: Permissions,
  ): IssuedToken {
    const issued: IssuedToken = {
      token: `ghs_${randomBytes(18).toString("hex")}`,
      installationId,
      repositoryIds,
      permissions,
      isRevoked: false,
    };
    this.issuedTokens.push(issued);
    return issued;
  }

  #revokeInstallationToken(authorization: string | undefined): Answer {
    const issued = this.#findInstallationToken(authorization);
    if (issued === undefined) {
      return { status: 401, body: { message: "Bad credentials" } };
    }
    issued.isRevoked = true;
    return { status: 204 };
  }

  #revokeUserToken(authorization: string | undefined, body: unknown): Answer {
    const expected = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
    if (authorization !== expected) {
      return { status: 401, body: { message: "Bad credentials" } };
    }
    const { access_token: token } = fieldsOf(body);
    this.#userTokens.delete(String(token));
    return { status: 204 };
  }

  #answerUser(route: string, url: URL, authorization: string | undefined): Answer {
    const user = this.#users.get(this.#userTokens.get(readBearer(authorization) ?? "") ?? "");
    if (user === undefined) {
      return { status: 401, body: { message: "Bad credentials" } };
    }
    if (route === "GET /user") {
      return { status: 200, body: { id: user.id, login: user.login, name: user.name ?? null } };
    }
    const reachable = (repositoryIds: Set<number>) =>
      [...repositoryIds].filter(
        (id) => user.pushRepositoryIds.has(id) || user.readRepositoryIds.has(id),
      );
    if (route === "GET /user/installations") {
      const installations = [...this.#installations]
        .filter(([, repositoryIds]) => reachable(repositoryIds).length > 0)
        .map(([id]) => ({ id, app_id: 1, account: { login: "someone" } }));
      return {
        status: 200,
        body: { total_count: installations.length, installations: page(installations, url) },
      };
    }
    const installation = route.match(/^GET \/user\/installations\/(\d+)\/repositories$/);
    const repositoryIds = this.#installations.get(Number(installation?.[1]));
    if (repositoryIds === undefined) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const repositories = reachable(repositoryIds).map((id) => {
      const repository = this.#repositories.find((candidate) => candidate.id === id);
      return {
        id,
        full_name: repository?.fullName,
        clone_url: repository?.cloneUrl,
        html_url: repository?.htmlUrl,
        default_branch: repository?.defaultBranch,
        private: repository?.isPrivate,
        permissions: { admin: false, pull: true, push: user.pushRepositoryIds.has(id) },
      };
    });
    return {
      status: 200,
      body: { total_count: repositories.length, repositories: page(repositories, url) },
    };
  }

  #answerPermission(fullName: string, login: string, authorization: string | undefined): Answer {
    const repository = this.#repositories.find((candidate) => candidate.fullName === fullName);
    const issued = this.#findInstallationToken(authorization);
    if (
      repository === undefined ||
      issued === undefined ||
      !issued.repositoryIds.includes(repository.id)
    ) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const user = this.#users.get(login);
    const canPush = user?.pushRepositoryIds.has(repository.id) ?? false;
    const canRead = canPush || (user?.readRepositoryIds.has(repository.id) ?? false);
    return {
      status: 200,
      body: {
        permission: canPush ? "write" : canRead ? "read" : "none",
        role_name: canPush ? "write" : "read",
        user:
          user === undefined
            ? null
            : { login, permissions: { pull: canRead, push: canPush, admin: false } },
      },
    };
  }

  #openPullRequest(fullName: string, authorization: string | undefined, body: unknown): Answer {
    const repository = this.#repositories.find((candidate) => candidate.fullName === fullName);
    const issued = this.#findInstallationToken(authorization);
    if (
      repository === undefined ||
      issued === undefined ||
      !issued.repositoryIds.includes(repository.id) ||
      issued.permissions.pull_requests !== "write"
    ) {
      return { status: 403, body: { message: "Resource not accessible by integration" } };
    }
    const fields = fieldsOf(body);
    const head = String(fields.head ?? "");
    if (
      this.pullRequests.some((pull) => pull.repositoryId === repository.id && pull.head === head)
    ) {
      return {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [{ message: `A pull request already exists for ${head}.` }],
        },
      };
    }
    const number =
      this.pullRequests.filter((pull) => pull.repositoryId === repository.id).length + 1;
    const pullRequest: FakePullRequest = {
      repositoryId: repository.id,
      number,
      title: String(fields.title ?? ""),
      body: String(fields.body ?? ""),
      head,
      base: String(fields.base ?? ""),
      url: `${repository.htmlUrl}/pull/${number}`,
    };
    this.pullRequests.push(pullRequest);
    return { status: 201, body: { number, html_url: pullRequest.url } };
  }

  #listPullRequests(fullName: string, url: URL, authorization: string | undefined): Answer {
    const repository = this.#repositories.find((candidate) => candidate.fullName === fullName);
    if (repository === undefined || this.#findInstallationToken(authorization) === undefined) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const head = url.searchParams.get("head")?.split(":")[1];
    return {
      status: 200,
      body: this.pullRequests
        .filter(
          (pull) =>
            pull.repositoryId === repository.id && (head === undefined || pull.head === head),
        )
        .map((pull) => ({ number: pull.number, html_url: pull.url })),
    };
  }

  async #isAppToken(authorization: string | undefined): Promise<boolean> {
    const token = readBearer(authorization);
    if (token === undefined) {
      return false;
    }
    try {
      const { payload } = await jwtVerify(token, this.#publicKey, {
        issuer: this.clientId,
        algorithms: ["RS256"],
      });
      return (payload.exp ?? 0) - (payload.iat ?? 0) <= 11 * 60;
    } catch {
      return false;
    }
  }

  #findInstallationToken(authorization: string | undefined): IssuedToken | undefined {
    const token = readBearer(authorization);
    return this.issuedTokens.find((issued) => issued.token === token && !issued.isRevoked);
  }

  #classifyCredential(authorization: string | undefined): RecordedRequest["credential"] {
    if (authorization === undefined) {
      return "none";
    }
    if (authorization.startsWith("Basic ")) {
      return "client";
    }
    const token = readBearer(authorization) ?? "";
    if (token.startsWith("ghs_")) {
      return "installation";
    }
    return token.startsWith("ghu_") ? "user" : "app";
  }

  #mintIdentifier(): number {
    this.#nextIdentifier += 1;
    return this.#nextIdentifier;
  }
}

function page<Item>(items: Item[], url: URL): Item[] {
  const perPage = Number(url.searchParams.get("per_page") ?? "30");
  const pageNumber = Number(url.searchParams.get("page") ?? "1");
  return items.slice((pageNumber - 1) * perPage, pageNumber * perPage);
}

function readBearer(authorization: string | undefined): string | undefined {
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
}

function readBasicPassword(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith("Basic ")) {
    return undefined;
  }
  const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString();
  return decoded.slice(decoded.indexOf(":") + 1);
}

function fieldsOf(body: unknown): RequestFields {
  return isRecord(body) ? (body as RequestFields) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString();
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}
