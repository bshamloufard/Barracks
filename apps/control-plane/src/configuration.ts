import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  readSandboxProviderConfiguration,
  type SandboxProviderConfiguration,
} from "@barrack/sandbox-providers";
import { z } from "zod";
import {
  type DatabaseConfiguration,
  databaseEnvironmentShape,
  describeProblems,
  toDatabaseConfiguration,
} from "./database/database-configuration.js";
import { readModelCredentials } from "./threads/model-credentials.js";
import { readPiSettings } from "./threads/pi-settings.js";
import type {
  AgentSettings,
  SupervisorEnvironmentSettings,
} from "./threads/supervisor-environment.js";

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

/** Addresses that only this machine can reach. */
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const environmentSchema = z
  .object({
    BARRACK_CONTROL_PLANE_HOST: z.string().min(1).default("127.0.0.1"),
    BARRACK_CONTROL_PLANE_PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
    BARRACK_SANDBOX_CONTROL_PLANE_URL: z
      .url({
        protocol: /^wss?$/,
        error:
          "required: the control plane's ws:// or wss:// URL as sandboxes reach it, e.g. ws://host.docker.internal:8787",
      })
      .transform((url) => url.replace(/\/+$/, "")),
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
    BARRACK_AGENT_HARNESS: z.enum(["pi", "fake"]).default("pi"),
    BARRACK_MODEL: z
      .string()
      .regex(/^[^/\s]+\/\S+$/, 'must be "provider/model", e.g. "openai/example-model"')
      .optional(),
    ...databaseEnvironmentShape,
  })
  .refine((settings) => settings.BARRACK_AGENT_HARNESS === "fake" || settings.BARRACK_MODEL, {
    path: ["BARRACK_MODEL"],
    error:
      'required for the Pi agent, in Pi\'s "provider/model" form; or set BARRACK_AGENT_HARNESS=fake',
  });

type Settings = z.infer<typeof environmentSchema>;

/** Every variable the control plane itself reads; each provider reads its own as well. */
export const controlPlaneVariableNames = Object.keys(environmentSchema.shape);

export type LogLevel = (typeof logLevels)[number];

export type ControlPlaneConfiguration = {
  host: string;
  port: number;
  allowedClientOrigins: string[];
  /** Where the built web client is; when set, the control plane serves it. */
  webClientDirectory: string | undefined;
  logLevel: LogLevel;
  /** Where thread history is stored; undefined keeps it in memory, where a restart loses it. */
  database: DatabaseConfiguration | undefined;
  /** Which provider creates threads' sandboxes. */
  sandboxProvider: SandboxProviderConfiguration;
  /** What every new sandbox's supervisor is told. Holds model keys: never log it. */
  supervisorEnvironment: SupervisorEnvironmentSettings;
};

export type ConfigurationResult =
  | { ok: true; configuration: ControlPlaneConfiguration }
  | { ok: false; problems: string[] };

/** Reads and checks every setting at once, so a misconfigured start reports all problems together. */
export function readConfiguration(environment: NodeJS.ProcessEnv): ConfigurationResult {
  const validation = environmentSchema.safeParse(environment);
  const sandboxProvider = readSandboxProviderConfiguration(environment);
  const problems = [
    ...(validation.success ? [] : describeProblems(validation.error)),
    ...(sandboxProvider.ok ? [] : sandboxProvider.problems),
  ];
  if (!validation.success || !sandboxProvider.ok) {
    return { ok: false, problems };
  }
  const settings = validation.data;
  const isolationProblem = describeUnisolatedProviderExposure(
    sandboxProvider.configuration,
    settings.BARRACK_CONTROL_PLANE_HOST,
  );
  if (isolationProblem !== undefined) {
    return { ok: false, problems: [isolationProblem] };
  }
  return {
    ok: true,
    configuration: toConfiguration(settings, sandboxProvider.configuration, environment),
  };
}

function toConfiguration(
  settings: Settings,
  sandboxProvider: SandboxProviderConfiguration,
  environment: NodeJS.ProcessEnv,
): ControlPlaneConfiguration {
  return {
    host: settings.BARRACK_CONTROL_PLANE_HOST,
    port: settings.BARRACK_CONTROL_PLANE_PORT,
    allowedClientOrigins: settings.BARRACK_ALLOWED_CLIENT_ORIGINS,
    webClientDirectory: settings.BARRACK_WEB_CLIENT_DIRECTORY,
    logLevel: settings.BARRACK_LOG_LEVEL,
    database: toDatabaseConfiguration(settings),
    sandboxProvider,
    supervisorEnvironment: {
      controlPlaneUrlForSandboxes: settings.BARRACK_SANDBOX_CONTROL_PLANE_URL,
      agent: toAgentSettings(settings),
      modelCredentials: readModelCredentials(environment),
      piSettings: readPiSettings(environment),
    },
  };
}

function toAgentSettings(settings: Settings): AgentSettings {
  if (settings.BARRACK_AGENT_HARNESS === "fake") {
    return { harness: "fake" };
  }
  if (settings.BARRACK_MODEL === undefined) {
    throw new Error("The configuration schema let the Pi agent through without a model");
  }
  return { harness: "pi", model: settings.BARRACK_MODEL };
}

/**
 * The local-process provider runs agents on this machine with no isolation,
 * so a control plane using it must not be reachable from any other: one more
 * reason it cannot end up in a deployment unnoticed.
 */
function describeUnisolatedProviderExposure(
  sandboxProvider: SandboxProviderConfiguration,
  host: string,
): string | undefined {
  if (sandboxProvider.kind !== "local-process" || loopbackHosts.has(host)) {
    return undefined;
  }
  return `BARRACK_CONTROL_PLANE_HOST: must be a loopback address (127.0.0.1, localhost or ::1) with the local-process sandbox provider, which runs agents unisolated on this machine`;
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
