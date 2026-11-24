import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * The browser origins the web client is served from during local development:
 * the Vite dev server, and the control plane itself when it serves the built
 * client. Both hostnames are listed because browsers treat them as different
 * origins.
 */
const localDevelopmentOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
];

/**
 * Long enough that guessing it is hopeless; `openssl rand -hex 32` produces
 * 64 characters.
 */
const minimumSupervisorTokenLength = 32;

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const environmentSchema = z.object({
  BARRACK_SUPERVISOR_TOKEN: z
    .string({ error: "required; it is the shared secret that sandbox supervisors present" })
    .min(minimumSupervisorTokenLength, {
      error: `must be at least ${minimumSupervisorTokenLength} characters long`,
    }),
  BARRACK_CONTROL_PLANE_HOST: z.string().min(1).default("127.0.0.1"),
  BARRACK_CONTROL_PLANE_PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  BARRACK_ALLOWED_CLIENT_ORIGINS: z
    .string()
    .default(localDevelopmentOrigins.join(","))
    .transform(splitCommaSeparatedList)
    .pipe(z.array(z.url().transform(originOf)).min(1)),
  BARRACK_WEB_CLIENT_DIRECTORY: z
    .string()
    .min(1)
    .refine(existsSync, { error: "must name a directory that exists" })
    .transform((directory) => resolve(directory))
    .optional(),
  BARRACK_LOG_LEVEL: z.enum(logLevels).default("info"),
});

export type LogLevel = (typeof logLevels)[number];

export type ControlPlaneConfiguration = {
  supervisorToken: string;
  host: string;
  port: number;
  allowedClientOrigins: string[];
  /** Where the built web client is; when set, the control plane serves it. */
  webClientDirectory: string | undefined;
  logLevel: LogLevel;
};

export type ConfigurationResult =
  | { ok: true; configuration: ControlPlaneConfiguration }
  | { ok: false; problems: string[] };

/** Reads and checks every setting at once, so a misconfigured start reports all problems together. */
export function readConfiguration(environment: NodeJS.ProcessEnv): ConfigurationResult {
  const validation = environmentSchema.safeParse(environment);
  if (!validation.success) {
    const problems = validation.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    return { ok: false, problems };
  }
  const settings = validation.data;
  return {
    ok: true,
    configuration: {
      supervisorToken: settings.BARRACK_SUPERVISOR_TOKEN,
      host: settings.BARRACK_CONTROL_PLANE_HOST,
      port: settings.BARRACK_CONTROL_PLANE_PORT,
      allowedClientOrigins: settings.BARRACK_ALLOWED_CLIENT_ORIGINS,
      webClientDirectory: settings.BARRACK_WEB_CLIENT_DIRECTORY,
      logLevel: settings.BARRACK_LOG_LEVEL,
    },
  };
}

function splitCommaSeparatedList(list: string): string[] {
  return list
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** Browsers send an origin without a path or trailing slash, so allowed origins are normalised to match. */
function originOf(url: string): string {
  return new URL(url).origin;
}
