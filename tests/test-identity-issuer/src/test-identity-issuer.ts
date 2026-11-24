import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  jwtVerify,
  SignJWT,
  UnsecuredJWT,
} from "jose";

/**
 * A stand-in for Supabase Auth's token issuer: an ES256 key pair, its public
 * key set served over HTTP on localhost at the path Supabase uses, a function
 * that mints access tokens with chosen claims and lifetimes, and the one
 * endpoint the control plane asks about a user (`/auth/v1/user`). The
 * control plane verifies these tokens through exactly the code it uses
 * against a real Supabase project, so the tests exercise fetching the key
 * set, checking claims and expiry, and key rotation.
 */

/** One signing key; it is trusted only while it is published in the key set. */
export type TestSigningKey = {
  keyId: string;
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  publicJwk: JWK;
};

export type AccessTokenRequest = {
  userId: string;
  email?: string;
  /** Seconds from now until it expires; negative for a token that has already expired. */
  expiresInSeconds?: number;
  /** Claims to add, replace or (with `undefined`) leave out, such as `{ role: "anon" }`. */
  claims?: Record<string, unknown>;
  /** Signs with this key rather than the current one, published or not. */
  signingKey?: TestSigningKey;
};

export type TestIdentityIssuerOptions = {
  /** Publish the first signing key at once; false starts with an empty key set. */
  publishInitialKey?: boolean;
};

const jwksPath = "/auth/v1/.well-known/jwks.json";
const userPath = "/auth/v1/user";

export class TestIdentityIssuer {
  /** Where the control plane is told Supabase is, e.g. `http://127.0.0.1:41234`. */
  readonly supabaseUrl: string;
  /** The `iss` claim, as Supabase sets it: the project URL with `/auth/v1`. */
  readonly issuer: string;
  readonly #server: Server;
  readonly #publishedKeys: TestSigningKey[] = [];
  readonly #unconfirmedEmailUserIds = new Set<string>();
  #currentKey: TestSigningKey;
  #keySetRequestCount = 0;

  private constructor(server: Server, port: number, firstKey: TestSigningKey) {
    this.#server = server;
    this.supabaseUrl = `http://127.0.0.1:${port}`;
    this.issuer = `${this.supabaseUrl}/auth/v1`;
    this.#currentKey = firstKey;
  }

  static async start(options: TestIdentityIssuerOptions = {}): Promise<TestIdentityIssuer> {
    const firstKey = await createSigningKey();
    const server = createServer();
    const port = await listenOnLoopback(server);
    const issuer = new TestIdentityIssuer(server, port, firstKey);
    server.on("request", (request, response) => void issuer.#answer(request, response));
    if (options.publishInitialKey ?? true) {
      issuer.publishSigningKey(firstKey);
    }
    return issuer;
  }

  /** How many times the key set has been fetched, to tell a cached key from a fresh fetch. */
  get keySetRequestCount(): number {
    return this.#keySetRequestCount;
  }

  /** A new key, not yet published, so tokens it signs are not yet trusted. */
  createSigningKey(): Promise<TestSigningKey> {
    return createSigningKey();
  }

  /** Adds a key to the published key set, as Supabase does with a standby key. */
  publishSigningKey(key: TestSigningKey): void {
    if (!this.#publishedKeys.includes(key)) {
      this.#publishedKeys.push(key);
    }
  }

  /** Makes a key the one new tokens are signed with, publishing it if it is not yet. */
  rotateTo(key: TestSigningKey): void {
    this.publishSigningKey(key);
    this.#currentKey = key;
  }

  /** Makes `/auth/v1/user` report the user's email address as not yet confirmed. */
  markEmailUnconfirmed(userId: string): void {
    this.#unconfirmedEmailUserIds.add(userId);
  }

  /** An access token shaped like Supabase's for a signed-in user, unless the request says otherwise. */
  async mintAccessToken(request: AccessTokenRequest): Promise<string> {
    const signingKey = request.signingKey ?? this.#currentKey;
    const payload = withoutUndefinedClaims({
      ...this.#standardClaims(request),
      ...request.claims,
    });
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid: signingKey.keyId, typ: "JWT" })
      .sign(signingKey.privateKey);
  }

  /** The same claims, signed with HS256 and a shared secret, as projects on the legacy secret do. */
  async mintSymmetricallySignedToken(request: AccessTokenRequest, secret: Uint8Array) {
    return new SignJWT(this.#standardClaims(request))
      .setProtectedHeader({ alg: "HS256", kid: this.#currentKey.keyId, typ: "JWT" })
      .sign(secret);
  }

  /** The same claims with no signature at all (`alg: none`). */
  mintUnsignedToken(request: AccessTokenRequest): string {
    return new UnsecuredJWT(this.#standardClaims(request)).encode();
  }

  /** The current public key as JSON text, which an algorithm-confusion attack uses as an HMAC secret. */
  currentPublicKeyText(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(this.#currentKey.publicJwk));
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.close((error) => (error === undefined ? resolve() : reject(error)));
      this.#server.closeAllConnections();
    });
  }

  #standardClaims(request: AccessTokenRequest): JWTPayload {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: this.issuer,
      aud: "authenticated",
      sub: request.userId,
      iat: now,
      exp: now + (request.expiresInSeconds ?? 3600),
      role: "authenticated",
      aal: "aal1",
      session_id: randomUUID(),
      email: request.email ?? "",
      phone: "",
      is_anonymous: false,
    };
  }

  async #answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = URL.parse(request.url ?? "", "http://placeholder.invalid")?.pathname;
    if (request.method === "GET" && path === jwksPath) {
      this.#keySetRequestCount += 1;
      sendJson(response, 200, { keys: this.#publishedKeys.map((key) => key.publicJwk) });
      return;
    }
    if (request.method === "GET" && path === userPath) {
      await this.#answerUserRequest(request, response);
      return;
    }
    sendJson(response, 404, { message: "Not found" });
  }

  /** What Supabase's `GET /auth/v1/user` answers, as far as the control plane reads it. */
  async #answerUserRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (token === undefined) {
      sendJson(response, 401, { message: "No bearer token" });
      return;
    }
    try {
      const keySet = createLocalJWKSet({ keys: this.#publishedKeys.map((key) => key.publicJwk) });
      const { payload } = await jwtVerify(token, keySet, { issuer: this.issuer });
      const { sub: userId = "", email } = payload;
      sendJson(response, 200, {
        id: userId,
        email,
        email_confirmed_at: this.#unconfirmedEmailUserIds.has(userId)
          ? null
          : new Date(0).toISOString(),
      });
    } catch {
      sendJson(response, 401, { message: "Invalid token" });
    }
  }
}

async function createSigningKey(): Promise<TestSigningKey> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const keyId = randomUUID();
  const publicJwk = { ...(await exportJWK(publicKey)), kid: keyId, alg: "ES256", use: "sig" };
  return { keyId, privateKey, publicJwk };
}

function withoutUndefinedClaims(claims: Record<string, unknown>): JWTPayload {
  return Object.fromEntries(Object.entries(claims).filter(([, value]) => value !== undefined));
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The test identity issuer has no TCP address."));
        return;
      }
      resolve(address.port);
    });
  });
}
