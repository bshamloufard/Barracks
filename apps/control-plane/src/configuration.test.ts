import { describe, expect, it } from "vitest";
import { readConfiguration } from "./configuration.js";

/** The fewest settings that start a control plane: where sandboxes run, how they reach it, the agent, and sign-in. */
const minimalEnvironment = {
  BARRACK_SUPABASE_URL: "https://project-ref.supabase.co/",
  BARRACK_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  BARRACK_ALLOWED_USER_EMAILS: "Owner@Example.com",
  BARRACK_SANDBOX_PROVIDER: "docker",
  BARRACK_DOCKER_IMAGE: "barrack-sandbox:dev",
  BARRACK_SANDBOX_CONTROL_PLANE_URL: "ws://host.docker.internal:8787/",
  BARRACK_AGENT_HARNESS: "fake",
};

const localProcessEnvironment = {
  BARRACK_AUTHENTICATION: "development-single-user",
  BARRACK_SANDBOX_PROVIDER: "local-process",
  BARRACK_ALLOW_UNISOLATED_SANDBOXES: "development-only",
  BARRACK_LOCAL_SANDBOX_DIRECTORY: "/tmp/barrack-sandboxes",
  BARRACK_LOCAL_SUPERVISOR_COMMAND: '["node", "supervisor.js"]',
  BARRACK_SANDBOX_CONTROL_PLANE_URL: "ws://127.0.0.1:8787",
  BARRACK_AGENT_HARNESS: "fake",
};

describe("the control plane configuration", () => {
  it("listens on the loopback interface, port 8787, when given only where sandboxes run, how they reach it and the agent", () => {
    const result = readConfiguration(minimalEnvironment);

    expect(result).toEqual({
      ok: true,
      configuration: {
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
        database: undefined,
        authentication: {
          method: "supabase",
          project: {
            url: "https://project-ref.supabase.co",
            publishableKey: "sb_publishable_example",
            issuer: "https://project-ref.supabase.co/auth/v1",
          },
          admission: {
            kind: "listed-email-addresses",
            emailAddresses: new Set(["owner@example.com"]),
          },
        },
        sandboxProvider: expect.objectContaining({ kind: "docker" }),
        supervisorEnvironment: {
          controlPlaneUrlForSandboxes: "ws://host.docker.internal:8787",
          agent: { harness: "fake" },
          modelCredentials: {},
          piSettings: {},
        },
        sandboxLifecycle: {
          idlePeriodInMilliseconds: 10 * 60_000,
          admission: { maximumPerUser: 3, maximumInInstallation: undefined },
          checkIntervalInMilliseconds: 30_000,
        },
      },
    });
  });

  it("reads when idle sandboxes stop, how many may run at once and how often they are checked", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      BARRACK_SANDBOX_IDLE_MINUTES: "0.5",
      BARRACK_RUNNING_SANDBOXES_PER_USER: "2",
      BARRACK_RUNNING_SANDBOXES_IN_TOTAL: "5",
      BARRACK_SANDBOX_CHECK_SECONDS: "2",
    });

    expect(result.ok && result.configuration.sandboxLifecycle).toEqual({
      idlePeriodInMilliseconds: 30_000,
      admission: { maximumPerUser: 2, maximumInInstallation: 5 },
      checkIntervalInMilliseconds: 2_000,
    });
  });

  it.each([
    ["BARRACK_SANDBOX_IDLE_MINUTES", "0"],
    ["BARRACK_RUNNING_SANDBOXES_PER_USER", "0"],
    ["BARRACK_RUNNING_SANDBOXES_PER_USER", "1.5"],
    ["BARRACK_RUNNING_SANDBOXES_IN_TOTAL", "none"],
    ["BARRACK_SANDBOX_CHECK_SECONDS", "-1"],
  ])("refuses %s=%s", (name, value) => {
    const result = readConfiguration({ ...minimalEnvironment, [name]: value });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.join("\n")).toContain(name);
  });

  it("has no shared supervisor token any more", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      BARRACK_SUPERVISOR_TOKEN: "a-shared-token-from-milestone-one",
    });

    expect(JSON.stringify(result)).not.toContain("a-shared-token-from-milestone-one");
  });

  it("runs Pi by default, which needs a model in provider/model form", () => {
    const { BARRACK_AGENT_HARNESS: _harness, ...withoutHarness } = minimalEnvironment;

    const withoutModel = readConfiguration(withoutHarness);
    const withModel = readConfiguration({
      ...withoutHarness,
      BARRACK_MODEL: "anthropic/example-model",
    });

    expect(withoutModel).toEqual({
      ok: false,
      problems: [expect.stringMatching(/^BARRACK_MODEL: required for the Pi agent/)],
    });
    expect(withModel.ok && withModel.configuration.supervisorEnvironment.agent).toEqual({
      harness: "pi",
      model: "anthropic/example-model",
    });
  });

  it("forwards only the allowlisted model provider keys to sandboxes", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      ANTHROPIC_API_KEY: "developer-key",
      AWS_SECRET_ACCESS_KEY: "cloud-credentials",
    });

    expect(result.ok && result.configuration.supervisorEnvironment.modelCredentials).toEqual({
      ANTHROPIC_API_KEY: "developer-key",
    });
  });

  it("forwards only the allowlisted Pi settings to sandboxes", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      PI_OFFLINE: "1",
      PI_SESSION_ID: "the-developer's-own-pi-session",
    });

    expect(result.ok && result.configuration.supervisorEnvironment.piSettings).toEqual({
      PI_OFFLINE: "1",
    });
  });

  it("reports every problem at once, the sandbox provider's included", () => {
    const result = readConfiguration({
      BARRACK_CONTROL_PLANE_PORT: "not-a-port",
      BARRACK_ALLOWED_CLIENT_ORIGINS: "not a url",
      BARRACK_WEB_CLIENT_DIRECTORY: "/no/such/directory",
      BARRACK_LOG_LEVEL: "loud",
      BARRACK_AGENT_HARNESS: "fake",
    });

    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems.map((problem) => problem.split(/[.:]/)[0])).toEqual([
      "BARRACK_CONTROL_PLANE_PORT",
      "BARRACK_SANDBOX_CONTROL_PLANE_URL",
      "BARRACK_ALLOWED_CLIENT_ORIGINS",
      "BARRACK_WEB_CLIENT_DIRECTORY",
      "BARRACK_LOG_LEVEL",
      "BARRACK_SUPABASE_URL",
      "BARRACK_SUPABASE_PUBLISHABLE_KEY",
      "BARRACK_ALLOWED_USER_EMAILS",
      "BARRACK_SANDBOX_PROVIDER",
    ]);
  });

  it("refuses a sandbox URL that is not a WebSocket URL", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      BARRACK_SANDBOX_CONTROL_PLANE_URL: "http://127.0.0.1:8787",
    });

    expect(result).toEqual({
      ok: false,
      problems: [expect.stringMatching(/^BARRACK_SANDBOX_CONTROL_PLANE_URL: required/)],
    });
  });

  it("accepts the local-process provider while listening on the loopback interface", () => {
    const result = readConfiguration(localProcessEnvironment);

    expect(result.ok && result.configuration.sandboxProvider.kind).toBe("local-process");
  });

  it("refuses the local-process provider on an interface other machines can reach, even with sign-in", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      ...localProcessEnvironment,
      BARRACK_AUTHENTICATION: "supabase",
      BARRACK_CONTROL_PLANE_HOST: "0.0.0.0",
    });

    expect(result).toEqual({
      ok: false,
      problems: [expect.stringMatching(/^BARRACK_CONTROL_PLANE_HOST: must be a loopback address/)],
    });
  });

  it("refuses development mode on an interface other machines, or sandboxes, can reach", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      BARRACK_AUTHENTICATION: "development-single-user",
      BARRACK_CONTROL_PLANE_HOST: "172.17.0.1",
    });

    expect(result).toEqual({
      ok: false,
      problems: [
        expect.stringMatching(
          /^BARRACK_CONTROL_PLANE_HOST: must be a loopback address .* BARRACK_AUTHENTICATION=development-single-user/,
        ),
      ],
    });
  });

  it("listens anywhere with Supabase authentication", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      BARRACK_CONTROL_PLANE_HOST: "0.0.0.0",
    });

    expect(result.ok && result.configuration.host).toBe("0.0.0.0");
  });

  it("needs no Supabase settings in development mode", () => {
    const result = readConfiguration(localProcessEnvironment);

    expect(result.ok && result.configuration.authentication).toEqual({
      method: "development-single-user",
    });
  });

  it("compares allowed origins the way browsers send them", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      BARRACK_ALLOWED_CLIENT_ORIGINS: "https://barrack.example/ , http://localhost:3000",
    });

    expect(result.ok && result.configuration.allowedClientOrigins).toEqual([
      "https://barrack.example",
      "http://localhost:3000",
    ]);
  });

  it("keeps threads and their history in memory when no database URL is given", () => {
    const result = readConfiguration(minimalEnvironment);

    expect(result.ok && result.configuration.database).toBeUndefined();
  });

  it("verifies the database's certificate by default, with a pool of five connections and a keep-alive every four hours", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
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
      keepAliveIntervalInMilliseconds: 4 * 60 * 60 * 1000,
    });
  });

  it("refuses a database URL whose query string would override the TLS settings", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
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
      ...minimalEnvironment,
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
