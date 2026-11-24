import { execFileSync } from "node:child_process";

/**
 * Whether the test that runs a thread in a real Docker container can run
 * here. It needs a reachable Docker daemon and the built sandbox image, and
 * it is slow, so it runs only when asked to with BARRACK_DOCKER_TESTS=1
 * (`pnpm test:docker`).
 */

const { BARRACK_DOCKER_TESTS: dockerTestsRequested, BARRACK_DOCKER_TEST_IMAGE: imageOverride } =
  process.env;

export const sandboxImage = imageOverride ?? "barrack-sandbox:dev";

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
