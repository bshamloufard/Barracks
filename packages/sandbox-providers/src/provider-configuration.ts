import { z } from "zod";
import type { DaytonaProviderSettings } from "./daytona/daytona-sandbox-provider.js";
import type { DockerProviderSettings } from "./docker/docker-run-arguments.js";

/**
 * Which provider runs the sandboxes, and its settings, read from environment
 * variables so that switching provider is a deployment setting. Every
 * problem is reported at once, and values are never echoed, since one of
 * them is an API key.
 */

export type SandboxProviderConfiguration =
  | { kind: "fake" }
  | { kind: "docker"; docker: DockerProviderSettings }
  | { kind: "daytona"; daytona: DaytonaProviderSettings & { apiKey: string } };

export type SandboxProviderConfigurationResult =
  | { ok: true; configuration: SandboxProviderConfiguration }
  | { ok: false; problems: string[] };

const positiveNumber = z.coerce.number().positive();
const positiveWholeNumber = z.coerce.number().int().positive();

const portListSchema = z
  .string()
  .transform((list) =>
    list
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== ""),
  )
  .pipe(z.array(z.coerce.number<string>().int().min(1).max(65_535)));

const dockerVariablesSchema = z.object({
  BARRACK_DOCKER_IMAGE: z.string().min(1),
  BARRACK_DOCKER_CPUS: positiveNumber.default(2),
  BARRACK_DOCKER_MEMORY_MEBIBYTES: positiveWholeNumber.default(4096),
  BARRACK_DOCKER_PROCESS_LIMIT: positiveWholeNumber.default(1024),
  BARRACK_DOCKER_STOP_TIMEOUT_SECONDS: positiveWholeNumber.default(15),
  BARRACK_DOCKER_SERVICE_PORTS: portListSchema.default([]),
  BARRACK_DOCKER_EXECUTABLE: z.string().min(1).default("docker"),
});

const daytonaVariablesSchema = z.object({
  DAYTONA_API_KEY: z.string().min(1),
  BARRACK_DAYTONA_SNAPSHOT: z.string().min(1),
  DAYTONA_TARGET: z.string().min(1).optional(),
  BARRACK_DAYTONA_AUTO_ARCHIVE_MINUTES: positiveWholeNumber.default(60),
});

const providerKindSchema = z.enum(["fake", "docker", "daytona"]);

export function readSandboxProviderConfiguration(
  environment: NodeJS.ProcessEnv,
): SandboxProviderConfigurationResult {
  const { BARRACK_SANDBOX_PROVIDER: providerName } = environment;
  const kind = providerKindSchema.safeParse(providerName);
  if (!kind.success) {
    return {
      ok: false,
      problems: ['BARRACK_SANDBOX_PROVIDER: must be "docker", "daytona" or "fake"'],
    };
  }
  switch (kind.data) {
    case "fake":
      return { ok: true, configuration: { kind: "fake" } };
    case "docker":
      return readDockerConfiguration(environment);
    case "daytona":
      return readDaytonaConfiguration(environment);
  }
}

function readDockerConfiguration(
  environment: NodeJS.ProcessEnv,
): SandboxProviderConfigurationResult {
  const parsed = dockerVariablesSchema.safeParse(environment);
  if (!parsed.success) {
    return { ok: false, problems: describeProblems(parsed.error) };
  }
  const variables = parsed.data;
  return {
    ok: true,
    configuration: {
      kind: "docker",
      docker: {
        image: variables.BARRACK_DOCKER_IMAGE,
        cpuLimit: variables.BARRACK_DOCKER_CPUS,
        memoryLimitInMebibytes: variables.BARRACK_DOCKER_MEMORY_MEBIBYTES,
        processLimit: variables.BARRACK_DOCKER_PROCESS_LIMIT,
        stopTimeoutInSeconds: variables.BARRACK_DOCKER_STOP_TIMEOUT_SECONDS,
        servicePorts: variables.BARRACK_DOCKER_SERVICE_PORTS,
        dockerExecutable: variables.BARRACK_DOCKER_EXECUTABLE,
      },
    },
  };
}

function readDaytonaConfiguration(
  environment: NodeJS.ProcessEnv,
): SandboxProviderConfigurationResult {
  const parsed = daytonaVariablesSchema.safeParse(environment);
  if (!parsed.success) {
    return { ok: false, problems: describeProblems(parsed.error) };
  }
  const variables = parsed.data;
  return {
    ok: true,
    configuration: {
      kind: "daytona",
      daytona: {
        apiKey: variables.DAYTONA_API_KEY,
        snapshot: variables.BARRACK_DAYTONA_SNAPSHOT,
        target: variables.DAYTONA_TARGET,
        autoArchiveIntervalInMinutes: variables.BARRACK_DAYTONA_AUTO_ARCHIVE_MINUTES,
      },
    },
  };
}

function describeProblems(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const variableName = String(issue.path[0] ?? "environment");
    const reason = issue.code === "invalid_type" ? "is required" : issue.message;
    return `${variableName}: ${reason}`;
  });
}
