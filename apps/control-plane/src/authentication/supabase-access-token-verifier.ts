import { createRemoteJWKSet, errors, type JWTPayload, jwtVerify } from "jose";
import { z } from "zod";
import type { AccessTokenVerification, AccessTokenVerifier } from "./access-token-verifier.js";
import { SupabaseEmailConfirmations } from "./supabase-email-confirmations.js";
import { type SupabaseProject, signingKeySetUrlOf } from "./supabase-project.js";

/**
 * Only asymmetric algorithms, so the public key set is all the control plane
 * needs and holds. Leaving out `HS256` and `none` also closes the attack in
 * which a token is "signed" with a public key used as a shared secret.
 * Supabase signs with ES256 (its recommendation) or RS256.
 * https://supabase.com/docs/guides/auth/signing-keys
 */
const allowedAlgorithms = ["ES256", "RS256"];

/** Supabase gives every signed-in user's token this audience and role. */
const userAudience = "authenticated";
const userRole = "authenticated";

/** Clocks on hosted services agree to well within this. */
const defaultClockToleranceInSeconds = 30;

const maximumUserIdLength = 255;

/** The claims read after the signature, issuer, audience and expiry have been checked. */
const userClaimsSchema = z.object({
  sub: z.string().min(1).max(maximumUserIdLength),
  exp: z.number(),
  role: z.string(),
  is_anonymous: z.boolean().optional(),
  email: z.string().optional(),
});

type UserClaims = z.infer<typeof userClaimsSchema>;

export type SupabaseAccessTokenVerifierOptions = {
  project: SupabaseProject;
  /**
   * Whether to find out from Supabase which tokens carry a confirmed email
   * address, which only an installation admitting users by address needs.
   */
  confirmEmailAddresses: boolean;
  clockToleranceInSeconds?: number;
  /**
   * How soon after fetching the key set a token signed with an unknown key
   * may make it be fetched again. jose's default is 30 seconds.
   */
  keySetCooldownInMilliseconds?: number;
};

/**
 * Verifies Supabase Auth access tokens itself: the signature against the
 * project's published key set (fetched and cached by jose, and fetched again
 * when a token names a key it has not seen, which is how a rotated key is
 * picked up), the issuer, the audience, the algorithm, the expiry with a
 * small tolerance, and that the token is a signed-in, non-anonymous user's.
 * https://supabase.com/docs/guides/auth/jwts
 */
export class SupabaseAccessTokenVerifier implements AccessTokenVerifier {
  readonly #project: SupabaseProject;
  readonly #keySet: ReturnType<typeof createRemoteJWKSet>;
  readonly #clockToleranceInSeconds: number;
  readonly #emailConfirmations: SupabaseEmailConfirmations | undefined;

  constructor(options: SupabaseAccessTokenVerifierOptions) {
    this.#project = options.project;
    this.#keySet = createRemoteJWKSet(
      signingKeySetUrlOf(options.project),
      options.keySetCooldownInMilliseconds === undefined
        ? {}
        : { cooldownDuration: options.keySetCooldownInMilliseconds },
    );
    this.#clockToleranceInSeconds =
      options.clockToleranceInSeconds ?? defaultClockToleranceInSeconds;
    this.#emailConfirmations = options.confirmEmailAddresses
      ? new SupabaseEmailConfirmations(options.project)
      : undefined;
  }

  async verify(accessToken: string): Promise<AccessTokenVerification> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(accessToken, this.#keySet, {
        issuer: this.#project.issuer,
        audience: userAudience,
        algorithms: allowedAlgorithms,
        clockTolerance: this.#clockToleranceInSeconds,
        requiredClaims: ["sub", "exp"],
      }));
    } catch (error) {
      return describeVerificationFailure(error);
    }
    const claims = userClaimsSchema.safeParse(payload);
    if (!claims.success) {
      return { ok: false, failure: "invalid", detail: "The token's claims are not a user's" };
    }
    const userProblem = describeNonUserToken(claims.data);
    if (userProblem !== undefined) {
      return { ok: false, failure: "invalid", detail: userProblem };
    }
    return this.#identify(accessToken, claims.data);
  }

  async #identify(accessToken: string, claims: UserClaims): Promise<AccessTokenVerification> {
    const userId = claims.sub;
    const validUntil = new Date((claims.exp + this.#clockToleranceInSeconds) * 1000);
    const emailAddress = claims.email?.toLowerCase() ?? "";
    if (this.#emailConfirmations === undefined || emailAddress === "") {
      return { ok: true, identity: { userId, confirmedEmailAddress: undefined, validUntil } };
    }
    const confirmation = await this.#emailConfirmations.check(accessToken, userId, emailAddress);
    switch (confirmation.outcome) {
      case "confirmed":
        return { ok: true, identity: { userId, confirmedEmailAddress: emailAddress, validUntil } };
      case "not_confirmed":
        return { ok: true, identity: { userId, confirmedEmailAddress: undefined, validUntil } };
      case "token_refused":
        return { ok: false, failure: "invalid", detail: "Supabase Auth refused the token" };
      case "unavailable":
        return { ok: false, failure: "unavailable", detail: confirmation.detail };
    }
  }
}

/** Anonymous Supabase users get `role: authenticated` too, so `is_anonymous` is checked as well. */
function describeNonUserToken(claims: UserClaims): string | undefined {
  if (claims.role !== userRole) {
    return `The token's role is not "${userRole}"`;
  }
  if (claims.is_anonymous === true) {
    return "The token belongs to an anonymous user";
  }
  return undefined;
}

/**
 * jose reports a key set it could not fetch with a timeout, a plain
 * `JOSEError` (a non-200 answer or one that is not JSON), `JWKSInvalid`, or
 * the fetch's own error; everything else it throws is about the token.
 */
function describeVerificationFailure(error: unknown): AccessTokenVerification {
  if (error instanceof errors.JWTExpired) {
    return { ok: false, failure: "expired", detail: "The token has expired" };
  }
  const isKeySetUnavailable =
    !(error instanceof errors.JOSEError) ||
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    error.code === "ERR_JOSE_GENERIC";
  const detail = error instanceof Error ? error.message : String(error);
  if (isKeySetUnavailable) {
    return {
      ok: false,
      failure: "unavailable",
      detail: `Could not fetch Supabase's signing keys: ${detail}`,
    };
  }
  return { ok: false, failure: "invalid", detail };
}
