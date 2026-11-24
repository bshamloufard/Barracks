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

function dockerSucceeds(dockerArguments: string[]): boolean {
  try {
    execFileSync("docker", dockerArguments, { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
