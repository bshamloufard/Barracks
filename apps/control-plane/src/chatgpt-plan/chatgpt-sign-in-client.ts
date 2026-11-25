import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import { z } from "zod";

/**
 * The control plane's side of OpenAI's "Sign in with ChatGPT" programme: an
 * OAuth 2 client of its authorization server, with OpenID Connect, as
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in and
 * the pages beside it describe (read 2026-11-25). Nothing here logs, and
 * nothing it returns holds more of a token than its caller asked for.
 */

/** The client a first sign-in registers through; the client it issues is used from then on. */
export const dynamicRegistrationClientId = "dynamic_agent_client";

/** The scopes for ChatGPT plan usage, and the identity ones beside them. */
export const planScope =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

/** The scope without which a sign-in does not authorize plan usage. */
export const planUsageScope = "chatgpt.tokens.use.direct";

/** What the tokens are for: OpenAI's API. */
export const planResource = "https://api.openai.com/v1";

/** The name OpenAI shows the user as the app asking, which they may edit before approving. */
export const agentNameHint = "Barrack";

/** OpenAI's endpoints, from its discovery document. */
export type SignInEndpoints = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  jwksUri: string;
};

/** What the token endpoint answered, as the control plane keeps it. */
export type IssuedTokens = {
  accessToken: string;
  refreshToken: string;
  idToken: string | undefined;
  expiresInSeconds: number;
  /**
   * The scopes granted, or undefined where the answer does not say, which
   * by RFC 6749 (section 5.1) means exactly those asked for.
   */
  scopes: readonly string[] | undefined;
  /** OpenAI's `earliest_refresh_at`, as a time, if it gave one that can be read. */
  earliestRenewalAt: Date | undefined;
};

/**
 * Why the token endpoint gave nothing:
 * - `unusable`: the code or refresh token is spent, expired, revoked or
 *   reused; the documented answer is to sign in again.
 * - `client_rejected`: OpenAI no longer accepts the issued client.
 * - `refused`: any other refusal, for this request.
 * - `unavailable`: OpenAI could not be reached, or failed; try later.
 */
export type TokenFailure = {
  kind: "token_failure";
  reason: "unusable" | "client_rejected" | "refused" | "unavailable";
  /** OpenAI's error code, never anything of a token, for the log. */
  code: string | undefined;
};

export type TokenOutcome = { kind: "issued"; tokens: IssuedTokens } | TokenFailure;

/** The ChatGPT account an ID token names, once it is checked. */
export type VerifiedAccount = { subject: string; email: string | undefined };

/**
 * The refresh-token errors the documentation says to answer by signing in
 * again (https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).
 */
const unusableTokenCodes = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

const requestTimeoutInMilliseconds = 15_000;

/** Seconds of clock difference allowed in an ID token's times, as OpenAI's own kit allows. */
const clockToleranceInSeconds = 5;

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  revocation_endpoint: z.string(),
  jwks_uri: z.string(),
});

/** How long an access token lasts where the answer does not say: an hour, as the documentation says. */
const documentedAccessTokenLifetimeInSeconds = 3600;

/**
 * A successful token answer. Only the two tokens must be there and
 * readable: a refresh token is spent once OpenAI answers, so an answer
 * that carries its replacement is kept whatever else in it is odd, rather
 * than dropped and the spent token presented again, which loses the
 * sign-in. Anything else unreadable is left out: the ID token (a sign-in
 * without one then fails its check), the lifetime (an hour, then), the
 * scopes (as asked, then) and `earliest_refresh_at`. `token_type` is not
 * read: the programme's tokens are bearer tokens whatever it says.
 */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  refresh_token: z.string().min(1).max(16_384),
  id_token: z.string().min(1).max(16_384).optional().catch(undefined),
  expires_in: z.number().positive().optional().catch(undefined),
  scope: z.string().max(4_096).optional().catch(undefined),
  earliest_refresh_at: z.union([z.number(), z.string()]).optional().catch(undefined),
});

const tokenErrorSchema = z.object({
  error: z.union([z.string(), z.object({ code: z.string().optional() }).loose()]),
});

export class ChatGptSignInClient {
  readonly #issuer: string;
  #endpoints: Promise<SignInEndpoints> | undefined;
  #keySet: ReturnType<typeof createRemoteJWKSet> | undefined;

  /** `issuer` is `https://auth.openai.com`, or a stand-in for it in tests. */
  constructor(issuer: string) {
    this.#issuer = issuer;
  }

  /**
   * OpenAI's endpoints, read once from its discovery document. Each must be
   * on the issuer's own origin, so a document that names another host is
   * refused rather than handed a code or a refresh token.
   */
  discover(): Promise<SignInEndpoints> {
    this.#endpoints ??= this.#readDiscovery().catch((error: unknown) => {
      this.#endpoints = undefined;
      throw error;
    });
    return this.#endpoints;
  }

  async buildAuthorizationUrl(request: {
    clientId: string;
    hostId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
    loginHint: string | undefined;
  }): Promise<string> {
    const { authorizationEndpoint } = await this.discover();
    const url = new URL(authorizationEndpoint);
    const isFirstSignIn = request.clientId === dynamicRegistrationClientId;
    const parameters: Array<[string, string | undefined]> = [
      ["response_type", "code"],
      ["client_id", request.clientId],
      // Only on a first registration, as the documentation says.
      ["agent_name_hint", isFirstSignIn ? agentNameHint : undefined],
      ["ext_agent_host_id", request.hostId],
      ["redirect_uri", request.redirectUri],
      ["scope", planScope],
      ["resource", planResource],
      ["state", request.state],
      ["nonce", request.nonce],
      ["code_challenge", request.codeChallenge],
      ["code_challenge_method", "S256"],
      // No `id_token_hint`: a saved token is kept out of browser addresses,
      // where history and extensions read them; the email hint suffices.
      ["login_hint", isFirstSignIn ? undefined : request.loginHint],
    ];
    for (const [name, value] of parameters) {
      if (value !== undefined) {
        url.searchParams.set(name, value);
      }
    }
    return url.href;
  }

  async exchangeCode(request: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<TokenOutcome> {
    return this.#requestTokens({
      grant_type: "authorization_code",
      client_id: request.clientId,
      code: request.code,
      code_verifier: request.codeVerifier,
      redirect_uri: request.redirectUri,
      resource: planResource,
    });
  }

  /** A new access token and a replacement refresh token; the one given is spent either way. */
  async renew(request: { clientId: string; refreshToken: string }): Promise<TokenOutcome> {
    return this.#requestTokens({
      grant_type: "refresh_token",
      client_id: request.clientId,
      refresh_token: request.refreshToken,
      resource: planResource,
    });
  }

  /**
   * Revokes the sign-in the refresh token belongs to. True once OpenAI
   * confirms it (an empty 200, even for a token already invalid); false
   * when it, or its discovery document, could not be reached or failed:
   * the caller tells the user it is not confirmed, which is all it can do.
   */
  async revoke(request: { clientId: string; refreshToken: string }): Promise<boolean> {
    try {
      const { revocationEndpoint } = await this.discover();
      const response = await fetch(revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: request.refreshToken,
          token_type_hint: "refresh_token",
          client_id: request.clientId,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutInMilliseconds),
      });
      await response.body?.cancel();
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Checks an ID token as the documentation requires: its signature against
   * OpenAI's published keys, its issuer, its audience the issued client,
   * its expiry, and the nonce sent for this sign-in. Throws
   * `IdTokenRejectedError` for one that fails.
   */
  async verifyIdToken(
    idToken: string,
    expected: { clientId: string; nonce: string },
  ): Promise<VerifiedAccount> {
    const endpoints = await this.discover();
    this.#keySet ??= createRemoteJWKSet(new URL(endpoints.jwksUri));
    let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
    try {
      ({ payload } = await jwtVerify(idToken, this.#keySet, {
        issuer: endpoints.issuer,
        audience: expected.clientId,
        algorithms: ["RS256"],
        clockTolerance: clockToleranceInSeconds,
        requiredClaims: ["iss", "aud", "exp", "iat", "sub"],
      }));
    } catch (error) {
      if (error instanceof joseErrors.JOSEError) {
        throw new IdTokenRejectedError(error.code);
      }
      throw error;
    }
    if (payload["nonce"] !== expected.nonce) {
      throw new IdTokenRejectedError("nonce_mismatch");
    }
    if (payload["azp"] !== undefined && payload["azp"] !== expected.clientId) {
      throw new IdTokenRejectedError("authorized_party_mismatch");
    }
    const email = payload["email"];
    const isEmailVerified = payload["email_verified"] === true;
    return {
      subject: String(payload.sub),
      email: isEmailVerified && typeof email === "string" && email !== "" ? email : undefined,
    };
  }

  async #readDiscovery(): Promise<SignInEndpoints> {
    const response = await fetch(`${this.#issuer}/.well-known/openid-configuration`, {
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutInMilliseconds),
    });
    if (!response.ok) {
      throw new Error(`OpenAI's sign-in discovery answered ${response.status}.`);
    }
    const document = discoverySchema.parse(await response.json());
    if (document.issuer !== this.#issuer) {
      throw new Error("OpenAI's sign-in discovery names another issuer.");
    }
    const endpoints = {
      issuer: document.issuer,
      authorizationEndpoint: document.authorization_endpoint,
      tokenEndpoint: document.token_endpoint,
      revocationEndpoint: document.revocation_endpoint,
      jwksUri: document.jwks_uri,
    };
    const issuerOrigin = new URL(this.#issuer).origin;
    const foreign = Object.values(endpoints).find(
      (endpoint) => new URL(endpoint).origin !== issuerOrigin,
    );
    if (foreign !== undefined) {
      throw new Error("OpenAI's sign-in discovery names an endpoint on another host.");
    }
    return endpoints;
  }

  async #requestTokens(form: Record<string, string>): Promise<TokenOutcome> {
    const { tokenEndpoint } = await this.discover();
    let response: Response;
    try {
      response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams(form),
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutInMilliseconds),
      });
    } catch {
      return { kind: "token_failure", reason: "unavailable", code: undefined };
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
      return readIssuedTokens(body);
    }
    return describeTokenFailure(response.status, body);
  }
}

/** Why an ID token was refused, by the check it failed; never the token. */
export class IdTokenRejectedError extends Error {
  constructor(readonly check: string) {
    super(`OpenAI's ID token failed a check (${check}).`);
    this.name = "IdTokenRejectedError";
  }
}

function readIssuedTokens(body: unknown): TokenOutcome {
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { kind: "token_failure", reason: "unavailable", code: "malformed_token_response" };
  }
  const answer = parsed.data;
  return {
    kind: "issued",
    tokens: {
      accessToken: answer.access_token,
      refreshToken: answer.refresh_token,
      idToken: answer.id_token,
      expiresInSeconds: Math.max(
        1,
        Math.floor(answer.expires_in ?? documentedAccessTokenLifetimeInSeconds),
      ),
      scopes: answer.scope?.split(" ").filter((scope) => scope !== ""),
      earliestRenewalAt: readEarliestRenewal(answer.earliest_refresh_at),
    },
  };
}

/**
 * The documentation lists `earliest_refresh_at` without its form; OpenAI's
 * own kit reads a number as seconds since 1970 and otherwise a date, and so
 * does this. One that cannot be read is left out.
 */
function readEarliestRenewal(value: number | string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** OpenAI's error code, from `error` itself or from `error.code`. */
function describeTokenFailure(status: number, body: unknown): TokenFailure {
  const parsed = tokenErrorSchema.safeParse(body);
  const error = parsed.success ? parsed.data.error : undefined;
  const code = typeof error === "string" ? error : error?.code;
  if (code !== undefined && unusableTokenCodes.has(code)) {
    return { kind: "token_failure", reason: "unusable", code };
  }
  if (code === "invalid_client") {
    return { kind: "token_failure", reason: "client_rejected", code };
  }
  const reason = status >= 500 || status === 429 ? "unavailable" : "refused";
  return { kind: "token_failure", reason, code: code?.slice(0, 64) };
}
