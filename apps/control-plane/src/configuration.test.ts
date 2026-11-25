import { describe, expect, it } from "vitest";
import { readConfiguration } from "./configuration.js";

/** Base64 of 32 bytes, as `openssl rand -base64 32` prints; for tests alone. */
const exampleCredentialKey = Buffer.alloc(32, 1).toString("base64");
const previousCredentialKey = Buffer.alloc(32, 2).toString("base64");

/** The fewest settings that start a control plane: where sandboxes run, how they reach it, the agent, sign-in, and the key credentials are sealed under. */
const minimalEnvironment = {
  BARRACK_MODEL_CREDENTIAL_KEY: exampleCredentialKey,
  BARRACK_SUPABASE_URL: "https://project-ref.supabase.co/",
  BARRACK_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  BARRACK_ALLOWED_USER_EMAILS: "Owner@Example.com",
  BARRACK_SANDBOX_PROVIDER: "docker",
  BARRACK_DOCKER_IMAGE: "barrack-sandbox:dev",
  BARRACK_SANDBOX_CONTROL_PLANE_URL: "ws://host.docker.internal:8787/",
  BARRACK_AGENT_HARNESS: "fake",
};

const localProcessEnvironment = {
  BARRACK_MODEL_CREDENTIAL_KEY: exampleCredentialKey,
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
          piSettings: {},
        },
        modelCredentialKeys: { current: Buffer.alloc(32, 1), previous: [] },
        sandboxLifecycle: {
          idlePeriodInMilliseconds: 10 * 60_000,
          admission: { maximumPerUser: 3, maximumInInstallation: undefined },
          checkIntervalInMilliseconds: 30_000,
        },
        github: {
          app: undefined,
          webUrl: "https://github.com",
          apiUrl: "https://api.github.com",
          allowPlainHttp: false,
        },
        modelUsageCap: { installationCapTokens: undefined, windowHours: 24 },
        modelProxyUpstreamOrigin: undefined,
        modelProxyRequestBodiesHeldInBytes: 128 * 1024 * 1024,
      },
    });
  });

  it("reads how much of request bodies the model proxy may hold at once", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      BARRACK_MODEL_PROXY_REQUEST_BODIES_MEBIBYTES: "64",
    });

    expect(result.ok && result.configuration.modelProxyRequestBodiesHeldInBytes).toBe(
      64 * 1024 * 1024,
    );
  });

  it("refuses to let the model proxy hold less than one request body of the largest size it relays", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      BARRACK_MODEL_PROXY_REQUEST_BODIES_MEBIBYTES: "31",
    });

    expect(result).toEqual({
      ok: false,
      problems: [
        expect.stringMatching(
          /^BARRACK_MODEL_PROXY_REQUEST_BODIES_MEBIBYTES: .*at least 32, the largest request body the model proxy relays/,
        ),
      ],
    });
  });

  it("reads the cap on each user's model usage and its window", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      BARRACK_MODEL_USAGE_CAP_TOKENS: "5000000",
      BARRACK_MODEL_USAGE_CAP_WINDOW_HOURS: "168",
    });

    expect(result.ok && result.configuration.modelUsageCap).toEqual({
      installationCapTokens: 5_000_000,
      windowHours: 168,
    });
  });

  it("points the model proxy elsewhere only in development mode, or when a second switch says so", () => {
    const inDevelopmentMode = readConfiguration({
      ...minimalEnvironment,
      BARRACK_AUTHENTICATION: "development-single-user",
      BARRACK_MODEL_PROXY_UPSTREAM_ORIGIN: "development-only:http://127.0.0.1:4010",
    });
    const withSupabaseAlone = readConfiguration({
      ...minimalEnvironment,
      BARRACK_MODEL_PROXY_UPSTREAM_ORIGIN: "development-only:http://127.0.0.1:4010",
    });

    expect(inDevelopmentMode.ok && inDevelopmentMode.configuration.modelProxyUpstreamOrigin).toBe(
      "http://127.0.0.1:4010",
    );
    expect(withSupabaseAlone).toEqual({
      ok: false,
      problems: [expect.stringContaining("BARRACK_ALLOW_UNSAFE_MODEL_PROXY_UPSTREAM")],
    });
  });

  it("points the model proxy elsewhere only when told it is for development", () => {
    const declared = readConfiguration({
      ...minimalEnvironment,
      BARRACK_ALLOW_UNSAFE_MODEL_PROXY_UPSTREAM: "development-only",
      BARRACK_MODEL_PROXY_UPSTREAM_ORIGIN: "development-only:http://127.0.0.1:4010",
    });
    const undeclared = readConfiguration({
      ...minimalEnvironment,
      BARRACK_MODEL_PROXY_UPSTREAM_ORIGIN: "http://127.0.0.1:4010",
    });
    const withPath = readConfiguration({
      ...minimalEnvironment,
      BARRACK_MODEL_PROXY_UPSTREAM_ORIGIN: "development-only:http://127.0.0.1:4010/v1",
    });

    expect(declared.ok && declared.configuration.modelProxyUpstreamOrigin).toBe(
      "http://127.0.0.1:4010",
    );
    expect(undeclared.ok).toBe(false);
    expect(withPath.ok).toBe(false);
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

  it("runs Pi by default, with no model of its own: each thread has one", () => {
    const { BARRACK_AGENT_HARNESS: _harness, ...withoutHarness } = minimalEnvironment;

    const result = readConfiguration(withoutHarness);

    expect(result.ok && result.configuration.supervisorEnvironment.agent).toEqual({
      harness: "pi",
    });
  });

  it("forwards no model provider key of its own to sandboxes", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      BARRACK_AGENT_HARNESS: "pi",
      ANTHROPIC_API_KEY: "developer-key",
    });

    expect(JSON.stringify(result.ok && result.configuration.supervisorEnvironment)).not.toContain(
      "developer-key",
    );
  });

  it("reads the key credentials are sealed under, and the previous ones while rotating", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      BARRACK_MODEL_CREDENTIAL_PREVIOUS_KEYS: ` ${previousCredentialKey} `,
    });

    expect(result.ok && result.configuration.modelCredentialKeys).toEqual({
      current: Buffer.alloc(32, 1),
      previous: [Buffer.alloc(32, 2)],
    });
  });

  it("requires a key of 32 bytes in base64 for credentials, never repeating what it was given", () => {
    const { BARRACK_MODEL_CREDENTIAL_KEY: _key, ...withoutKey } = minimalEnvironment;
    const shortKey = Buffer.alloc(16, 3).toString("base64");

    const missing = readConfiguration(withoutKey);
    const short = readConfiguration({
      ...minimalEnvironment,
      BARRACK_MODEL_CREDENTIAL_KEY: shortKey,
    });

    expect(missing).toEqual({
      ok: false,
      problems: [expect.stringMatching(/^BARRACK_MODEL_CREDENTIAL_KEY: required: base64 of 32/)],
    });
    expect(short).toEqual({
      ok: false,
      problems: [expect.stringMatching(/^BARRACK_MODEL_CREDENTIAL_KEY: must be 32 bytes/)],
    });
    expect(JSON.stringify(short)).not.toContain(shortKey);
  });

  it("forwards only the allowlisted Pi settings to sandboxes", () => {
    const result = readConfiguration({
      ...minimalEnvironment,
      PI_CACHE_RETENTION: "long",
      PI_OFFLINE: "1",
      PI_SESSION_ID: "the-developer's-own-pi-session",
    });

    expect(result.ok && result.configuration.supervisorEnvironment.piSettings).toEqual({
      PI_CACHE_RETENTION: "long",
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
      "BARRACK_MODEL_CREDENTIAL_KEY",
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
