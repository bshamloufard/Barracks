import { execFileSync } from "node:child_process";
import type { DockerProviderSettings } from "@barrack/sandbox-providers";

/**
 * Whether the test that runs a thread in a real Docker container can run
 * here. It needs a reachable Docker daemon and the built sandbox image, and
 * it is slow, so it runs only when asked to with BARRACK_DOCKER_TESTS=1
 * (`pnpm test:docker`).
 */

const { BARRACK_DOCKER_TESTS: dockerTestsRequested, BARRACK_DOCKER_TEST_IMAGE: imageOverride } =
  process.env;

export const sandboxImage = imageOverride ?? "barrack-sandbox:dev";

/**
 * The Docker provider's settings for every test sandbox, whether the control
 * plane creates it or a test stops and starts it directly. The stop timeout
 * is the provider's default, which the supervisor's stages of stopping Pi
 * are designed to fit (apps/sandbox-supervisor/src/pi/pi-stop-timing.ts);
 * Pi needs more memory than the fake agent.
 */
export const testDockerSettings = {
  image: sandboxImage,
  cpuLimit: 1,
  memoryLimitInMebibytes: 1024,
  processLimit: 256,
  stopTimeoutInSeconds: 15,
  servicePorts: [],
  dockerExecutable: "docker",
} satisfies DockerProviderSettings;

/** Why the Docker test cannot run, or undefined if it can. */
export function describeWhyDockerTestCannotRun(): string | undefined {
  if (dockerTestsRequested !== "1") {
    return "set BARRACK_DOCKER_TESTS=1, or run pnpm test:docker, to run it";
  }
  if (!dockerSucceeds(["info"])) {
    return "no Docker daemon is reachable";
  }
  if (!dockerSucceeds(["image", "inspect", sandboxImage])) {
    return `the image ${sandboxImage} is not built; run pnpm sandbox-image:build`;
  }
  return undefined;
}

/** The host's address on Docker's default bridge network. */
export function findDockerBridgeGateway(): string {
  return execFileSync(
    "docker",
    ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"],
    { encoding: "utf8" },
  ).trim();
}

/** The Docker provider labels each sandbox's container with its thread. */
export function findSandboxIdOf(threadId: string): string {
  const containerIds = execFileSync(
    "docker",
    [
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--quiet",
      "--filter",
      `label=barrack.thread-id=${threadId}`,
    ],
    { encoding: "utf8", timeout: 30_000 },
  )
    .split("\n")
    .filter((line) => line !== "");
  const [sandboxId] = containerIds;
  if (sandboxId === undefined || containerIds.length !== 1) {
    throw new Error(`Expected one sandbox for thread ${threadId}, found ${containerIds.length}.`);
  }
  return sandboxId;
}

/**
 * The supervisor token the control plane gave a sandbox, read from its
 * container's configuration. The control plane never reveals a token, so a
 * test that must look for one gets it the way only someone in charge of the
 * Docker daemon can, which on this machine is as good as root anyway.
 */
export function readSupervisorTokenOf(sandboxId: string): string {
  const variables: unknown = JSON.parse(
    execFileSync(
      "docker",
      ["container", "inspect", "--format", "{{json .Config.Env}}", sandboxId],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    ),
  );
  const prefix = "BARRACK_SUPERVISOR_TOKEN=";
  const variable = Array.isArray(variables)
    ? variables.find((entry) => typeof entry === "string" && entry.startsWith(prefix))
    : undefined;
  if (typeof variable !== "string" || variable.length === prefix.length) {
    throw new Error(`Sandbox ${sandboxId} has no supervisor token in its configuration.`);
  }
  return variable.slice(prefix.length);
}

/**
 * Writes a file into a sandbox as the agent's user, who owns the agent's
 * directories; `docker exec` would otherwise run as the supervisor's.
 *
 * Like every process `docker exec` starts, this one has the container's
 * environment, supervisor token included, which the agent could read while
 * it runs. That is acceptable for a test's set-up, which ends before the
 * agent runs anything; see sandbox-image/README.md.
 */
export function writeFileInSandboxAsAgent(
  sandboxId: string,
  filePath: string,
  contents: string,
): void {
  execFileSync(
    "docker",
    [
      "exec",
      "--interactive",
      "--user",
      "barrack-agent",
      sandboxId,
      ...["sh", "-c", 'cat > "$1"', "sh", filePath],
    ],
    { input: contents, stdio: ["pipe", "ignore", "pipe"], timeout: 30_000 },
  );
}

/** How a stopped sandbox's main process, the supervisor, ended, and what it logged. */
export function readSandboxExit(sandboxId: string): {
  exitCode: number;
  supervisorLogMessages: string[];
} {
  const exitCode = execFileSync(
    "docker",
    ["container", "inspect", "--format", "{{.State.ExitCode}}", sandboxId],
    { encoding: "utf8", timeout: 30_000 },
  );
  const logs = execFileSync("docker", ["container", "logs", sandboxId], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { exitCode: Number(exitCode), supervisorLogMessages: readLogMessages(logs) };
}

/** The `msg` of each JSON log line; anything else in the output is skipped. */
function readLogMessages(logs: string): string[] {
  return logs.split("\n").flatMap((line) => {
    try {
      const message: unknown = JSON.parse(line)?.msg;
      return typeof message === "string" ? [message] : [];
    } catch {
      return [];
    }
  });
}

function dockerSucceeds(dockerArguments: string[]): boolean {
  try {
    execFileSync("docker", dockerArguments, { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
