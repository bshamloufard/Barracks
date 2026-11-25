import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

/**
 * A stand-in for OpenAI's "Sign in with ChatGPT" authorization server, as
 * its documentation describes it (read 2026-11-25):
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 * https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
 * https://developers.openai.com/siwc/token-sharing-open-source/token-reference
 * https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
 *
 * - Discovery at `/.well-known/openid-configuration`, and its RS256 keys at
 *   `/.well-known/jwks.json`.
 * - `/api/accounts/authorize`: checks every parameter the documentation
 *   requires, and stands for the user approving. A first sign-in, with
 *   `client_id=dynamic_agent_client`, registers a client and returns its
 *   issued `client_id` on the callback; a later one with that client may
 *   leave it out. A browser would be sent to the callback, an address on
 *   `127.0.0.1` that nothing listens on; `approve` returns that address, as
 *   the user would copy it, and a GET answers with it as a redirect.
 * - `/api/accounts/oauth/token`: the code (once, within a minute, with the
 *   PKCE verifier, redirect and resource it was issued for) for an access
 *   token of an hour, a refresh token and an ID token; a refresh token for
 *   a new pair, the old one retired. A retired refresh token presented
 *   again is reuse: it is refused, and every token of its sign-in revoked.
 * - `/api/accounts/oauth/revoke`: revokes a sign-in by its refresh token.
 *
 * Nothing here has been compared with OpenAI's real server; the deployment
 * guide's first-deployment checklist lists what a real sign-in must confirm.
 */

export const dynamicClientId = "dynamic_agent_client";
export const planScopes =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const planResource = "https://api.openai.com/v1";

/** A ChatGPT account that can approve sign-ins. */
export type FakeChatGptAccount = {
  subject: string;
  email: string;
  /** False makes the model server refuse its plan as not eligible. */
  isEligible: boolean;
};

/** Whether an access token presented to OpenAI's API is one of this server's, and good. */
export type AccessTokenCheck =
  | { kind: "valid"; account: FakeChatGptAccount }
  | { kind: "expired" | "revoked" }
  | { kind: "unknown" };

export type FakeChatGptSignInOptions = {
  /** Seconds an access token lasts; the documentation says 3600. */
  accessTokenLifetimeInSeconds?: number;
  /** Seconds after issuing tokens before they may be renewed (`earliest_refresh_at`); none by default. */
  earliestRefreshDelayInSeconds?: number;
};

type SigningKey = {
  keyId: string;
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  publicJwk: JWK;
};

type IssuedClient = { clientId: string; subject: string; hostId: string };

type IssuedCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  nonce: string;
  subject: string;
  expiresAt: number;
};

/** One sign-in's tokens: its refresh tokens in order, the last one current. */
type Grant = {
  clientId: string;
  subject: string;
  refreshTokens: string[];
  accessTokens: Map<string, number>;
  isRevoked: boolean;
};

const authorizePath = "/api/accounts/authorize";
const tokenPath = "/api/accounts/oauth/token";
const revocationPath = "/api/accounts/oauth/revoke";
const jwksPath = "/.well-known/jwks.json";
const discoveryPath = "/.well-known/openid-configuration";
const codeLifetimeInMilliseconds = 60_000;

export class FakeChatGptSignIn {
  /** Where the control plane is told OpenAI's sign-in is, such as `http://127.0.0.1:41234`. */
  readonly issuer: string;
  readonly #server: Server;
  readonly #signingKey: SigningKey;
  readonly #accessTokenLifetimeInSeconds: number;
  readonly #earliestRefreshDelayInSeconds: number;
  readonly #accounts = new Map<string, FakeChatGptAccount>();
  readonly #clients = new Map<string, IssuedClient>();
  readonly #codes = new Map<string, IssuedCode>();
  readonly #grants: Grant[] = [];
  /** Every refresh asked of the token endpoint, good or not, in order. */
  readonly refreshAttempts: Array<{ outcome: "renewed" | "reused" | "refused" }> = [];
  /** Every revocation asked for. */
  readonly revocations: string[] = [];
  /** How long a refresh waits before answering, to let tests overlap them. */
  refreshDelayInMilliseconds = 0;
  /** Answers every token request with this status while set, as an outage would. */
  failTokenRequestsWithStatus: number | undefined;
  /** Claims the next ID token carries in place of the right ones, to test their checks. */
  nextIdTokenClaims: Record<string, unknown> | undefined;
  /** The scopes the next token answer grants in place of the plan's, as a user declining plan usage. */
  nextGrantedScope: string | undefined;
  /**
   * Members of the next token answer replaced, or left out where given as
   * undefined, to answer as a token endpoint the documentation does not pin
   * down might.
   */
  nextTokenAnswerChanges: Record<string, unknown> | undefined;
  #now: () => number = Date.now;

  private constructor(
    server: Server,
    port: number,
    signingKey: SigningKey,
    options: FakeChatGptSignInOptions,
  ) {
    this.#server = server;
    this.issuer = `http://127.0.0.1:${port}`;
    this.#signingKey = signingKey;
    this.#accessTokenLifetimeInSeconds = options.accessTokenLifetimeInSeconds ?? 3600;
    this.#earliestRefreshDelayInSeconds = options.earliestRefreshDelayInSeconds ?? 0;
  }

  static async start(options: FakeChatGptSignInOptions = {}): Promise<FakeChatGptSignIn> {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const keyId = randomToken("key");
    const publicJwk = { ...(await exportJWK(publicKey)), kid: keyId, alg: "RS256", use: "sig" };
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("The fake sign-in server is not listening on a TCP port.");
    }
    const signIn = new FakeChatGptSignIn(
      server,
      address.port,
      { keyId, privateKey, publicJwk },
      options,
    );
    server.on("request", (request, response) => {
      signIn.#answer(request, response).catch((error: unknown) => {
        response.writeHead(500).end(String(error));
      });
    });
    return signIn;
  }

  /** Lets a test move time on, for expiries. */
  useClock(now: () => number): void {
    this.#now = now;
  }

  addAccount(account: FakeChatGptAccount): void {
    this.#accounts.set(account.subject, account);
  }

  /**
   * The user approving the sign-in `authorizationUrl` begins as `subject`:
   * the address the browser is sent to, which Barrack is then given. Throws
   * for an authorization request the documentation would refuse.
   */
  approve(authorizationUrl: string, subject: string): string {
    const request = new URL(authorizationUrl).searchParams;
    const problem = findAuthorizationProblem(request);
    if (problem !== undefined) {
      throw new Error(`The authorization request is refused: ${problem}`);
    }
    if (!this.#accounts.has(subject)) {
      throw new Error(`There is no ChatGPT account "${subject}".`);
    }
    const clientId = this.#resolveClient(request, subject);
    const code = randomToken("code");
    this.#codes.set(code, {
      clientId,
      redirectUri: request.get("redirect_uri") ?? "",
      codeChallenge: request.get("code_challenge") ?? "",
      resource: request.get("resource") ?? "",
      nonce: request.get("nonce") ?? "",
      subject,
      expiresAt: this.#now() + codeLifetimeInMilliseconds,
    });
    const callback = new URL(request.get("redirect_uri") ?? "");
    callback.searchParams.set("code", code);
    callback.searchParams.set(
      "scope",
      "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
    );
    callback.searchParams.set("state", request.get("state") ?? "");
    if (request.get("client_id") === dynamicClientId) {
      callback.searchParams.set("client_id", clientId);
    }
    return callback.href;
  }

  /** The user declining: the address the browser is sent to. */
  deny(authorizationUrl: string): string {
    const request = new URL(authorizationUrl).searchParams;
    const callback = new URL(request.get("redirect_uri") ?? "");
    callback.searchParams.set("error", "access_denied");
    callback.searchParams.set("state", request.get("state") ?? "");
    return callback.href;
  }

  /** What OpenAI's API would make of an access token. */
  checkAccessToken(accessToken: string): AccessTokenCheck {
    for (const grant of this.#grants) {
      const expiresAt = grant.accessTokens.get(accessToken);
      if (expiresAt === undefined) {
        continue;
      }
      if (grant.isRevoked) {
        return { kind: "revoked" };
      }
      if (expiresAt <= this.#now()) {
        return { kind: "expired" };
      }
      const account = this.#accounts.get(grant.subject);
      return account === undefined ? { kind: "revoked" } : { kind: "valid", account };
    }
    return { kind: "unknown" };
  }

  /** Whether any of the sign-in's tokens can still be used: false once revoked, by reuse or by request. */
  isSignInRevoked(subject: string): boolean {
    return this.#grants
      .filter((grant) => grant.subject === subject)
      .every((grant) => grant.isRevoked);
  }

  /** Revokes every sign-in of the account, as removing the app in ChatGPT's settings would. */
  revokeEverySignInOf(subject: string): void {
    for (const grant of this.#grants.filter((candidate) => candidate.subject === subject)) {
      grant.isRevoked = true;
    }
  }

  /** Every access and refresh token issued so far, to look for where they must never be. */
  get issuedTokens(): string[] {
    return this.#grants.flatMap((grant) => [...grant.accessTokens.keys(), ...grant.refreshTokens]);
  }

  /** The clients registered, by issued identifier, with their account and host. */
  get registeredClients(): readonly IssuedClient[] {
    return [...this.#clients.values()];
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.closeAllConnections();
      this.#server.close(() => resolve());
    });
  }

  #resolveClient(request: URLSearchParams, subject: string): string {
    const requested = request.get("client_id") ?? "";
    if (requested !== dynamicClientId) {
      const client = this.#clients.get(requested);
      if (client === undefined || client.subject !== subject) {
        throw new Error("The issued client is not this account's.");
      }
      return requested;
    }
    const clientId = randomToken("oaiapp");
    this.#clients.set(clientId, {
      clientId,
      subject,
      hostId: request.get("ext_agent_host_id") ?? "",
    });
    return clientId;
  }

  async #answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.issuer);
    if (request.method === "GET" && url.pathname === discoveryPath) {
      writeJson(response, 200, this.#describeDiscovery());
      return;
    }
    if (request.method === "GET" && url.pathname === jwksPath) {
      writeJson(response, 200, { keys: [this.#signingKey.publicJwk] });
      return;
    }
    if (request.method === "GET" && url.pathname === authorizePath) {
      this.#answerAuthorize(url, response);
      return;
    }
    if (request.method === "POST" && url.pathname === tokenPath) {
      await this.#answerToken(await readForm(request), response);
      return;
    }
    if (request.method === "POST" && url.pathname === revocationPath) {
      this.#answerRevocation(await readForm(request), response);
      return;
    }
    response.writeHead(404).end();
  }

  /** As a browser meets it: approved at once by the only account there is. */
  #answerAuthorize(url: URL, response: ServerResponse): void {
    const [account] = this.#accounts.values();
    if (account === undefined) {
      writeJson(response, 400, { error: "no_account" });
      return;
    }
    response.writeHead(302, { location: this.approve(url.href, account.subject) }).end();
  }

  async #answerToken(form: URLSearchParams, response: ServerResponse): Promise<void> {
    if (this.failTokenRequestsWithStatus !== undefined) {
      writeJson(response, this.failTokenRequestsWithStatus, { error: "server_error" });
      return;
    }
    switch (form.get("grant_type")) {
      case "authorization_code":
        await this.#exchangeCode(form, response);
        return;
      case "refresh_token":
        await new Promise((resolve) => setTimeout(resolve, this.refreshDelayInMilliseconds));
        await this.#refresh(form, response);
        return;
      default:
        writeJson(response, 400, { error: "unsupported_grant_type" });
    }
  }

  async #exchangeCode(form: URLSearchParams, response: ServerResponse): Promise<void> {
    const code = this.#codes.get(form.get("code") ?? "");
    this.#codes.delete(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const isGood =
      code !== undefined &&
      code.expiresAt > this.#now() &&
      code.clientId === form.get("client_id") &&
      code.redirectUri === form.get("redirect_uri") &&
      code.resource === form.get("resource") &&
      code.codeChallenge === createHash("sha256").update(verifier).digest("base64url");
    if (!isGood) {
      writeJson(response, 400, {
        error: "invalid_grant",
        error_description: "The code is not good.",
      });
      return;
    }
    const grant: Grant = {
      clientId: code.clientId,
      subject: code.subject,
      refreshTokens: [],
      accessTokens: new Map(),
      isRevoked: false,
    };
    this.#grants.push(grant);
    writeJson(response, 200, await this.#issueTokens(grant, code.nonce));
  }

  async #refresh(form: URLSearchParams, response: ServerResponse): Promise<void> {
    const presented = form.get("refresh_token") ?? "";
    const grant = this.#grants.find((candidate) => candidate.refreshTokens.includes(presented));
    const isCurrent = grant?.refreshTokens.at(-1) === presented;
    if (grant === undefined || grant.isRevoked || grant.clientId !== form.get("client_id")) {
      this.refreshAttempts.push({ outcome: "refused" });
      writeJson(response, 400, { error: "invalid_grant", error_description: "Unusable." });
      return;
    }
    if (!isCurrent) {
      // Reuse revokes the whole sign-in: the documentation leaves open
      // whether it does, so the stand-in takes the stricter reading.
      grant.isRevoked = true;
      this.refreshAttempts.push({ outcome: "reused" });
      writeJson(response, 400, {
        error: "refresh_token_reused",
        error_description: "Your refresh token has already been used.",
      });
      return;
    }
    this.refreshAttempts.push({ outcome: "renewed" });
    writeJson(response, 200, await this.#issueTokens(grant, undefined));
  }

  #answerRevocation(form: URLSearchParams, response: ServerResponse): void {
    const token = form.get("token") ?? "";
    this.revocations.push(token);
    const grant = this.#grants.find((candidate) => candidate.refreshTokens.includes(token));
    if (grant !== undefined && grant.clientId === form.get("client_id")) {
      grant.isRevoked = true;
    }
    // An empty 200 for any token, already invalid or not, as documented.
    response.writeHead(200).end();
  }

  async #issueTokens(grant: Grant, nonce: string | undefined): Promise<object> {
    const now = this.#now();
    const accessToken = randomToken("fake-chatgpt-access");
    const refreshToken = randomToken("rt");
    grant.accessTokens.set(accessToken, now + this.#accessTokenLifetimeInSeconds * 1000);
    grant.refreshTokens.push(refreshToken);
    const account = this.#accounts.get(grant.subject);
    const issuedAt = Math.floor(now / 1000);
    const claims = {
      iss: this.issuer,
      sub: grant.subject,
      aud: [grant.clientId],
      iat: issuedAt,
      exp: issuedAt + 3600,
      email: account?.email ?? "",
      email_verified: true,
      ...(nonce === undefined ? {} : { nonce }),
      ...this.nextIdTokenClaims,
    };
    this.nextIdTokenClaims = undefined;
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: this.#signingKey.keyId })
      .sign(this.#signingKey.privateKey);
    const scope = this.nextGrantedScope ?? planScopes;
    this.nextGrantedScope = undefined;
    const changes = this.nextTokenAnswerChanges ?? {};
    this.nextTokenAnswerChanges = undefined;
    const answer: Record<string, unknown> = {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      token_type: "Bearer",
      expires_in: this.#accessTokenLifetimeInSeconds,
      scope,
      earliest_refresh_at: issuedAt + this.#earliestRefreshDelayInSeconds,
      ...changes,
    };
    return Object.fromEntries(Object.entries(answer).filter(([, value]) => value !== undefined));
  }

  #describeDiscovery(): object {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}${authorizePath}`,
      token_endpoint: `${this.issuer}${tokenPath}`,
      revocation_endpoint: `${this.issuer}${revocationPath}`,
      jwks_uri: `${this.issuer}${jwksPath}`,
      id_token_signing_alg_values_supported: ["RS256"],
    };
  }
}

/** What the documentation requires of an authorization request, or undefined when it is all there. */
function findAuthorizationProblem(request: URLSearchParams): string | undefined {
  const redirect = URL.canParse(request.get("redirect_uri") ?? "")
    ? new URL(request.get("redirect_uri") ?? "")
    : undefined;
  const scopes = new Set((request.get("scope") ?? "").split(" "));
  const checks: Array<[boolean, string]> = [
    [request.get("response_type") === "code", "response_type must be code"],
    [(request.get("client_id") ?? "") !== "", "client_id is required"],
    [
      redirect?.protocol === "http:" &&
        redirect.hostname === "127.0.0.1" &&
        redirect.pathname === "/auth/callback",
      "redirect_uri must be http://127.0.0.1:<port>/auth/callback",
    ],
    [
      planScopes.split(" ").every((scope) => scopes.has(scope)),
      "scope must include the plan's scopes",
    ],
    [request.get("resource") === planResource, `resource must be ${planResource}`],
    [request.get("code_challenge_method") === "S256", "code_challenge_method must be S256"],
    [(request.get("code_challenge") ?? "").length >= 43, "code_challenge is required"],
    [(request.get("state") ?? "") !== "", "state is required"],
    [(request.get("nonce") ?? "") !== "", "nonce is required"],
    [
      /^urn:uuid:[0-9a-f-]{36}$/.test(request.get("ext_agent_host_id") ?? ""),
      "ext_agent_host_id is required",
    ],
    [
      request.get("client_id") === dynamicClientId || !request.has("agent_name_hint"),
      "agent_name_hint goes only with a first registration",
    ],
  ];
  return checks.find(([isMet]) => !isMet)?.[1];
}

function randomToken(prefix: string): string {
  return `${prefix}-${randomBytes(24).toString("base64url")}`;
}

function writeJson(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return new URLSearchParams(body);
}
