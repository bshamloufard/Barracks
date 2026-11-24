import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { readAuthenticationConfiguration } from "./authentication-configuration.js";

const supabaseEnvironment = {
  BARRACK_SUPABASE_URL: "https://project-ref.supabase.co",
  BARRACK_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  BARRACK_ALLOWED_USER_EMAILS: "ada@example.com, Grace@Example.com",
};

function problemsOf(environment: NodeJS.ProcessEnv): string[] {
  const result = readAuthenticationConfiguration(environment);
  return result.ok ? [] : result.problems;
}

/** A legacy Supabase API key: a JWT naming its role, signed with the project's secret. */
function legacyApiKey(role: string): Promise<string> {
  return new SignJWT({ role, iss: "supabase" })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode("the-project-secret"));
}

describe("the authentication configuration", () => {
  it("signs users in with Supabase by default, admitting the listed addresses, compared in lower case", () => {
    expect(readAuthenticationConfiguration(supabaseEnvironment)).toEqual({
      ok: true,
      configuration: {
        method: "supabase",
        project: {
          url: "https://project-ref.supabase.co",
          publishableKey: "sb_publishable_example",
          issuer: "https://project-ref.supabase.co/auth/v1",
        },
        admission: {
          kind: "listed-email-addresses",
          emailAddresses: new Set(["ada@example.com", "grace@example.com"]),
        },
      },
    });
  });

  it("refuses to start with Supabase but no allowed addresses, rather than admitting everyone", () => {
    const { BARRACK_ALLOWED_USER_EMAILS: _, ...withoutList } = supabaseEnvironment;

    expect(problemsOf(withoutList)).toEqual([
      expect.stringMatching(/^BARRACK_ALLOWED_USER_EMAILS: required with Supabase/),
    ]);
    expect(problemsOf({ ...withoutList, BARRACK_ALLOWED_USER_EMAILS: " , " })).toEqual([
      expect.stringMatching(/^BARRACK_ALLOWED_USER_EMAILS: must list at least one/),
    ]);
  });

  it("admits anyone who can sign in only when told so in so many words, and alone", () => {
    const anyone = readAuthenticationConfiguration({
      ...supabaseEnvironment,
      BARRACK_ALLOWED_USER_EMAILS: "anyone-who-can-sign-in",
    });

    expect(anyone.ok && anyone.configuration).toMatchObject({
      admission: { kind: "anyone-who-can-sign-in" },
    });
    expect(
      problemsOf({
        ...supabaseEnvironment,
        BARRACK_ALLOWED_USER_EMAILS: "anyone-who-can-sign-in, ada@example.com",
      }),
    ).toEqual([expect.stringMatching(/must be either "anyone-who-can-sign-in" alone/)]);
    expect(
      problemsOf({ ...supabaseEnvironment, BARRACK_ALLOWED_USER_EMAILS: "everyone" }),
    ).toHaveLength(1);
  });

  it("refuses a secret key, which would reach every browser", async () => {
    for (const secretKey of ["sb_secret_example", await legacyApiKey("service_role")]) {
      expect(
        problemsOf({ ...supabaseEnvironment, BARRACK_SUPABASE_PUBLISHABLE_KEY: secretKey }),
      ).toEqual([expect.stringMatching(/^BARRACK_SUPABASE_PUBLISHABLE_KEY: is a secret key/)]);
    }
    expect(
      problemsOf({
        ...supabaseEnvironment,
        BARRACK_SUPABASE_PUBLISHABLE_KEY: await legacyApiKey("anon"),
      }),
    ).toEqual([]);
  });

  it("requires HTTPS for Supabase except on this machine", () => {
    expect(
      problemsOf({ ...supabaseEnvironment, BARRACK_SUPABASE_URL: "http://project.example" }),
    ).toEqual([expect.stringMatching(/^BARRACK_SUPABASE_URL: must use https/)]);
    expect(
      problemsOf({ ...supabaseEnvironment, BARRACK_SUPABASE_URL: "http://127.0.0.1:54321" }),
    ).toEqual([]);
  });

  it("takes another issuer when the project's tokens name a custom domain", () => {
    const result = readAuthenticationConfiguration({
      ...supabaseEnvironment,
      BARRACK_SUPABASE_JWT_ISSUER: "https://auth.barrack.example/auth/v1",
    });

    expect(result.ok && result.configuration).toMatchObject({
      project: { issuer: "https://auth.barrack.example/auth/v1" },
    });
  });

  it("needs nothing else for development mode, and refuses an unknown method", () => {
    expect(
      readAuthenticationConfiguration({ BARRACK_AUTHENTICATION: "development-single-user" }),
    ).toEqual({ ok: true, configuration: { method: "development-single-user" } });
    expect(problemsOf({ BARRACK_AUTHENTICATION: "none" })).toEqual([
      expect.stringMatching(/^BARRACK_AUTHENTICATION/),
    ]);
  });
});
