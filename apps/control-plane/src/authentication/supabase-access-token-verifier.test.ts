import { setTimeout as sleep } from "node:timers/promises";
import { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireAsymmetricSigningKeys } from "./signing-key-check.js";
import {
  SupabaseAccessTokenVerifier,
  type SupabaseAccessTokenVerifierOptions,
} from "./supabase-access-token-verifier.js";
import type { SupabaseProject } from "./supabase-project.js";

let issuer: TestIdentityIssuer;

beforeEach(async () => {
  issuer = await TestIdentityIssuer.start();
});

afterEach(async () => {
  await issuer.close();
});

function projectOf(testIssuer: TestIdentityIssuer): SupabaseProject {
  return {
    url: testIssuer.supabaseUrl,
    publishableKey: "sb_publishable_test",
    issuer: testIssuer.issuer,
  };
}

function createVerifier(
  options: Partial<SupabaseAccessTokenVerifierOptions> = {},
): SupabaseAccessTokenVerifier {
  return new SupabaseAccessTokenVerifier({
    project: projectOf(issuer),
    confirmEmailAddresses: false,
    clockToleranceInSeconds: 0,
    ...options,
  });
}

const user = { userId: "4b1a7a52-0d2e-4d8e-9a43-3f0c5e1b2a10", email: "ada@example.com" };

describe("verifying a Supabase access token", () => {
  it("accepts a signed-in user's token, saying who it is and until when", async () => {
    const token = await issuer.mintAccessToken({ ...user, expiresInSeconds: 600 });
    const before = Date.now();

    const verification = await createVerifier().verify(token);

    expect(verification).toEqual({
      ok: true,
      identity: {
        userId: user.userId,
        confirmedEmailAddress: undefined,
        validUntil: expect.any(Date),
      },
    });
    const validUntil = verification.ok ? (verification.identity.validUntil?.getTime() ?? 0) : 0;
    expect(validUntil).toBeGreaterThan(before + 598_000);
    expect(validUntil).toBeLessThanOrEqual(before + 601_000);
  });

  it("counts the clock tolerance as part of the token's life", async () => {
    const token = await issuer.mintAccessToken({ ...user, expiresInSeconds: -10 });

    const lenient = await createVerifier({ clockToleranceInSeconds: 30 }).verify(token);
    const strict = await createVerifier({ clockToleranceInSeconds: 0 }).verify(token);

    expect(lenient.ok).toBe(true);
    expect(strict).toMatchObject({ ok: false, failure: "expired" });
  });

  it.each([
    ["has expired", { expiresInSeconds: -60 }, "expired"],
    [
      "comes from another issuer",
      { claims: { iss: "https://elsewhere.supabase.co/auth/v1" } },
      "invalid",
    ],
    ["is meant for another audience", { claims: { aud: "anon" } }, "invalid"],
    ["belongs to an anonymous user", { claims: { is_anonymous: true } }, "invalid"],
    ["carries another role", { claims: { role: "service_role" } }, "invalid"],
    ["names no user", { claims: { sub: undefined } }, "invalid"],
    ["names an empty user", { claims: { sub: "" } }, "invalid"],
    ["has no expiry", { claims: { exp: undefined } }, "invalid"],
  ] as const)("refuses a token that %s", async (_, request, failure) => {
    const token = await issuer.mintAccessToken({ ...user, ...request });

    expect(await createVerifier().verify(token)).toMatchObject({ ok: false, failure });
  });

  it("refuses a token with no signature at all", async () => {
    const token = issuer.mintUnsignedToken(user);

    expect(await createVerifier().verify(token)).toMatchObject({ ok: false, failure: "invalid" });
  });

  it("refuses a token signed with HS256, even using the public key as the shared secret", async () => {
    const token = await issuer.mintSymmetricallySignedToken(user, issuer.currentPublicKeyText());

    expect(await createVerifier().verify(token)).toMatchObject({ ok: false, failure: "invalid" });
  });

  it("refuses text that is not a token", async () => {
    expect(await createVerifier().verify("not.a.token")).toMatchObject({
      ok: false,
      failure: "invalid",
    });
  });

  it("refuses a token signed with a key the issuer has not published, and accepts it once the key is published", async () => {
    const verifier = createVerifier({ keySetCooldownInMilliseconds: 0 });
    expect((await verifier.verify(await issuer.mintAccessToken(user))).ok).toBe(true);
    const nextKey = await issuer.createSigningKey();
    const token = await issuer.mintAccessToken({ ...user, signingKey: nextKey });

    const beforePublishing = await verifier.verify(token);
    issuer.rotateTo(nextKey);
    const afterPublishing = await verifier.verify(token);

    expect(beforePublishing).toMatchObject({ ok: false, failure: "invalid" });
    expect(afterPublishing.ok).toBe(true);
  });

  it("fetches the key set again for an unknown key only after the cooldown, and caches it otherwise", async () => {
    const verifier = createVerifier({ keySetCooldownInMilliseconds: 300 });
    await verifier.verify(await issuer.mintAccessToken(user));
    await verifier.verify(await issuer.mintAccessToken(user));
    const fetchesForKnownKey = issuer.keySetRequestCount;
    const nextKey = await issuer.createSigningKey();
    issuer.rotateTo(nextKey);
    const tokenWithNewKey = await issuer.mintAccessToken(user);

    const duringCooldown = await verifier.verify(tokenWithNewKey);
    await sleep(350);
    const afterCooldown = await verifier.verify(tokenWithNewKey);

    expect(fetchesForKnownKey).toBe(1);
    expect(duringCooldown).toMatchObject({ ok: false, failure: "invalid" });
    expect(afterCooldown.ok).toBe(true);
    expect(issuer.keySetRequestCount).toBe(2);
  });

  it("says it cannot decide, rather than refusing, when the key set cannot be fetched", async () => {
    const token = await issuer.mintAccessToken(user);
    await issuer.close();

    const verification = await createVerifier().verify(token);
    issuer = await TestIdentityIssuer.start();

    expect(verification).toMatchObject({ ok: false, failure: "unavailable" });
  });
});

describe("confirming a token's email address with Supabase", () => {
  it("gives the email address, lower-cased, once Supabase confirms the user owns it", async () => {
    const token = await issuer.mintAccessToken({ ...user, email: "Ada@Example.com" });

    const verification = await createVerifier({ confirmEmailAddresses: true }).verify(token);

    expect(verification).toMatchObject({
      ok: true,
      identity: { confirmedEmailAddress: "ada@example.com" },
    });
  });

  it("gives no email address when Supabase has not confirmed it, whatever the token claims", async () => {
    issuer.markEmailUnconfirmed(user.userId);
    const token = await issuer.mintAccessToken({
      ...user,
      claims: { user_metadata: { email_verified: true } },
    });

    const verification = await createVerifier({ confirmEmailAddresses: true }).verify(token);

    expect(verification).toMatchObject({
      ok: true,
      identity: { confirmedEmailAddress: undefined },
    });
  });

  it("does not ask Supabase when no email address needs confirming", async () => {
    issuer.markEmailUnconfirmed(user.userId);
    const token = await issuer.mintAccessToken(user);

    const verification = await createVerifier({ confirmEmailAddresses: false }).verify(token);

    expect(verification).toMatchObject({
      ok: true,
      identity: { confirmedEmailAddress: undefined },
    });
  });
});

describe("checking a Supabase project's signing keys at startup", () => {
  it("passes when the project publishes a public signing key", async () => {
    await expect(requireAsymmetricSigningKeys(projectOf(issuer))).resolves.toBeUndefined();
  });

  it("fails, telling the owner to rotate, when the project publishes none (it still uses the legacy shared secret)", async () => {
    const legacyIssuer = await TestIdentityIssuer.start({ publishInitialKey: false });

    const check = requireAsymmetricSigningKeys(projectOf(legacyIssuer));

    await expect(check).rejects.toThrow(
      /legacy shared secret.*rotate to an asymmetric signing key/,
    );
    await legacyIssuer.close();
  });

  it("fails, naming the setting, when the project cannot be reached", async () => {
    const project = projectOf(issuer);
    await issuer.close();

    await expect(requireAsymmetricSigningKeys(project)).rejects.toThrow(/BARRACK_SUPABASE_URL/);
    issuer = await TestIdentityIssuer.start();
  });
});
