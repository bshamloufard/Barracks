import { describe, expect, it } from "vitest";
import { readConfiguration } from "./configuration.js";

const validToken = "a".repeat(32);

describe("the control plane configuration", () => {
  it("listens on the loopback interface, port 8787, when only the token is given", () => {
    const result = readConfiguration({ BARRACK_SUPERVISOR_TOKEN: validToken });

    expect(result).toEqual({
      ok: true,
      configuration: {
        supervisorToken: validToken,
        host: "127.0.0.1",
        port: 8787,
        allowedClientOrigins: [
          "http://localhost:5173",
          "http://127.0.0.1:5173",
          "http://localhost:8787",
          "http://127.0.0.1:8787",
        ],
        webClientDirectory: undefined,
        logLevel: "info",
      },
    });
  });

  it("refuses to start without a supervisor token", () => {
    const result = readConfiguration({});

    expect(result).toEqual({
      ok: false,
      problems: [expect.stringMatching(/^BARRACK_SUPERVISOR_TOKEN: required/)],
    });
  });

  it("reports every problem at once", () => {
    const result = readConfiguration({
      BARRACK_SUPERVISOR_TOKEN: "short",
      BARRACK_CONTROL_PLANE_PORT: "not-a-port",
      BARRACK_ALLOWED_CLIENT_ORIGINS: "not a url",
      BARRACK_WEB_CLIENT_DIRECTORY: "/no/such/directory",
      BARRACK_LOG_LEVEL: "loud",
    });

    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems.map((problem) => problem.split(/[.:]/)[0])).toEqual([
      "BARRACK_SUPERVISOR_TOKEN",
      "BARRACK_CONTROL_PLANE_PORT",
      "BARRACK_ALLOWED_CLIENT_ORIGINS",
      "BARRACK_WEB_CLIENT_DIRECTORY",
      "BARRACK_LOG_LEVEL",
    ]);
  });

  it("never repeats the supervisor token in a problem", () => {
    const shortSecret = "secret-but-short";

    const result = readConfiguration({ BARRACK_SUPERVISOR_TOKEN: shortSecret });

    expect(JSON.stringify(result)).not.toContain(shortSecret);
  });

  it("compares allowed origins the way browsers send them", () => {
    const result = readConfiguration({
      BARRACK_SUPERVISOR_TOKEN: validToken,
      BARRACK_ALLOWED_CLIENT_ORIGINS: "https://barrack.example/ , http://localhost:3000",
    });

    expect(result.ok && result.configuration.allowedClientOrigins).toEqual([
      "https://barrack.example",
      "http://localhost:3000",
    ]);
  });

  it("keeps thread history in memory when no database URL is given", () => {
    const result = readConfiguration({ BARRACK_SUPERVISOR_TOKEN: validToken });

    expect(result.ok && result.configuration.database).toBeUndefined();
  });

  it("verifies the database's certificate by default, with a pool of five connections", () => {
    const result = readConfiguration({
      BARRACK_SUPERVISOR_TOKEN: validToken,
      BARRACK_DATABASE_URL:
        "postgresql://postgres.project:p%40ss%2Fword@aws-0-eu-west-1.pooler.supabase.com:5432/postgres",
    });

    expect(result.ok && result.configuration.database).toEqual({
      host: "aws-0-eu-west-1.pooler.supabase.com",
      port: 5432,
      databaseName: "postgres",
      user: "postgres.project",
      password: "p@ss/word",
      tlsMode: "verify-full",
      certificateAuthorities: undefined,
      poolSize: 5,
    });
  });

  it("refuses a database URL whose query string would override the TLS settings", () => {
    const result = readConfiguration({
      BARRACK_SUPERVISOR_TOKEN: validToken,
      BARRACK_DATABASE_URL: "postgres://user:secret@db.example:5432/barrack?sslmode=disable",
    });

    expect(result).toEqual({
      ok: false,
      problems: [expect.stringMatching(/^BARRACK_DATABASE_URL: must not contain query parameters/)],
    });
  });

  it("reports every database problem at once without repeating the URL or its password", () => {
    const password = "correct-horse-battery-staple";

    const result = readConfiguration({
      BARRACK_SUPERVISOR_TOKEN: validToken,
      BARRACK_DATABASE_URL: `mysql://user:${password}@db.example/barrack`,
      BARRACK_DATABASE_TLS: "require",
      BARRACK_DATABASE_CA_CERTIFICATE: "not a certificate",
      BARRACK_DATABASE_POOL_SIZE: "0",
    });

    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems.map((problem) => problem.split(":")[0])).toEqual([
      "BARRACK_DATABASE_URL",
      "BARRACK_DATABASE_TLS",
      "BARRACK_DATABASE_CA_CERTIFICATE",
      "BARRACK_DATABASE_POOL_SIZE",
    ]);
    expect(JSON.stringify(result)).not.toContain(password);
  });
});
