import { createPrivateKey, type KeyObject } from "node:crypto";
import { z } from "zod";

/**
 * The installation's GitHub App, through which users link their GitHub
 * accounts and threads work on private repositories. It is optional: without
 * it, threads can still clone public repositories, and the GitHub parts of
 * the web client say that GitHub is not set up here.
 *
 * The App's private key and client secret stay in the control plane. Nothing
 * derived from them reaches a sandbox but short-lived, read-only tokens for
 * one repository.
 */
export type GithubAppSettings = {
  /** The App's client ID: the `iss` of its JSON Web Tokens, and its OAuth client. */
  clientId: string;
  clientSecret: string;
  privateKey: KeyObject;
  /** The App's URL name, as in `https://github.com/apps/<slug>`. */
  slug: string;
};

export type GithubSettings = {
  /** Undefined when this installation has no GitHub App. */
  app: GithubAppSettings | undefined;
  /** `https://github.com`, or a stand-in for it in tests. */
  webUrl: string;
  /** `https://api.github.com`, or a stand-in for it in tests. */
  apiUrl: string;
  /**
   * Whether repository URLs (and the two above) may be `http://`: only for
   * tests and local development, never with a real GitHub.
   */
  allowPlainHttp: boolean;
};

const appVariableNames = [
  "BARRACK_GITHUB_APP_CLIENT_ID",
  "BARRACK_GITHUB_APP_CLIENT_SECRET",
  "BARRACK_GITHUB_APP_PRIVATE_KEY",
  "BARRACK_GITHUB_APP_SLUG",
] as const;

const githubEnvironmentSchema = z.object({
  BARRACK_GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
  BARRACK_GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
  BARRACK_GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  BARRACK_GITHUB_APP_SLUG: z
    .string()
    .regex(/^[a-z0-9-]+$/, "must be the App's URL name, as in https://github.com/apps/<slug>")
    .optional(),
  BARRACK_GITHUB_URL: z.url().default("https://github.com"),
  BARRACK_GITHUB_API_URL: z.url().default("https://api.github.com"),
  BARRACK_ALLOW_PLAIN_HTTP_REPOSITORIES: z
    .literal("development-only", { error: 'must be exactly "development-only", or unset' })
    .optional(),
});

/** Every variable read here, for the deployment guide's check. */
export const githubVariableNames = Object.keys(githubEnvironmentSchema.shape);

export type GithubSettingsResult =
  | { ok: true; settings: GithubSettings }
  | { ok: false; problems: string[] };

export function readGithubSettings(environment: NodeJS.ProcessEnv): GithubSettingsResult {
  const validation = githubEnvironmentSchema.safeParse(environment);
  if (!validation.success) {
    return {
      ok: false,
      problems: validation.error.issues.map(
        (issue) => `${String(issue.path[0] ?? "environment")}: ${issue.message}`,
      ),
    };
  }
  const variables = validation.data;
  const allowPlainHttp = variables.BARRACK_ALLOW_PLAIN_HTTP_REPOSITORIES === "development-only";
  const problems = [
    ...describeInsecureUrl("BARRACK_GITHUB_URL", variables.BARRACK_GITHUB_URL, allowPlainHttp),
    ...describeInsecureUrl(
      "BARRACK_GITHUB_API_URL",
      variables.BARRACK_GITHUB_API_URL,
      allowPlainHttp,
    ),
  ];
  const app = readAppSettings(variables);
  if (!app.ok) {
    problems.push(...app.problems);
  }
  if (problems.length > 0 || !app.ok) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    settings: {
      app: app.settings,
      webUrl: withoutTrailingSlash(variables.BARRACK_GITHUB_URL),
      apiUrl: withoutTrailingSlash(variables.BARRACK_GITHUB_API_URL),
      allowPlainHttp,
    },
  };
}

type Variables = z.infer<typeof githubEnvironmentSchema>;

/** All four or none: half an App would fail only once a user tried it. */
function readAppSettings(
  variables: Variables,
): { ok: true; settings: GithubAppSettings | undefined } | { ok: false; problems: string[] } {
  const missing = appVariableNames.filter((name) => variables[name] === undefined);
  if (missing.length === appVariableNames.length) {
    return { ok: true, settings: undefined };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      problems: missing.map(
        (name) =>
          `${name}: required with the other BARRACK_GITHUB_APP_ variables; set all four for a GitHub App, or none`,
      ),
    };
  }
  const privateKey = readPrivateKey(variables.BARRACK_GITHUB_APP_PRIVATE_KEY ?? "");
  if (privateKey === undefined) {
    return {
      ok: false,
      problems: [
        "BARRACK_GITHUB_APP_PRIVATE_KEY: must be the App's RSA private key, the whole PEM file GitHub generated",
      ],
    };
  }
  return {
    ok: true,
    settings: {
      clientId: variables.BARRACK_GITHUB_APP_CLIENT_ID ?? "",
      clientSecret: variables.BARRACK_GITHUB_APP_CLIENT_SECRET ?? "",
      privateKey,
      slug: variables.BARRACK_GITHUB_APP_SLUG ?? "",
    },
  };
}

/**
 * GitHub hands out keys in PKCS#1 form (`BEGIN RSA PRIVATE KEY`), which
 * Node reads as well as PKCS#8. Dashboards that store a variable on one line
 * often turn its line breaks into `\n`, so those are turned back.
 */
function readPrivateKey(pem: string): KeyObject | undefined {
  try {
    const key = createPrivateKey(pem.replaceAll("\\n", "\n"));
    return key.asymmetricKeyType === "rsa" ? key : undefined;
  } catch {
    return undefined;
  }
}

function describeInsecureUrl(name: string, url: string, allowPlainHttp: boolean): string[] {
  const { protocol } = new URL(url);
  if (protocol === "https:" || (protocol === "http:" && allowPlainHttp)) {
    return [];
  }
  return [`${name}: must be an https:// URL`];
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
