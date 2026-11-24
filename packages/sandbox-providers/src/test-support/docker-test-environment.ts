import { execFileSync } from "node:child_process";

/**
 * Whether the tests that run real Docker containers can run here. They are
 * slow (they start and stop containers from the sandbox image), so they run
 * only when asked to with BARRACK_DOCKER_TESTS=1, which `pnpm test:docker`
 * sets, and they need a reachable Docker daemon and the built image.
 */

const { BARRACK_DOCKER_TESTS: dockerTestsRequested, BARRACK_DOCKER_TEST_IMAGE: imageOverride } =
  process.env;

export const dockerTestImage = imageOverride ?? "barrack-sandbox:dev";

/** Why the Docker tests cannot run, or undefined if they can. */
export function describeWhyDockerTestsCannotRun(): string | undefined {
  if (dockerTestsRequested !== "1") {
    return "set BARRACK_DOCKER_TESTS=1, or run pnpm test:docker, to run tests against Docker";
  }
  if (!succeeds(["info"])) {
    return "no Docker daemon is reachable";
  }
  if (!succeeds(["image", "inspect", dockerTestImage])) {
    return `the image ${dockerTestImage} is not built; run pnpm sandbox-image:build`;
  }
  return undefined;
}

/**
 * The address of the host on Docker's default bridge network. A server bound
 * to it is reachable from containers (as host.docker.internal) and from the
 * host itself, but not from other machines, unlike one bound to 0.0.0.0.
 */
export function findDockerBridgeGateway(): string {
  return execFileSync(
    "docker",
    ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"],
    { encoding: "utf8" },
  ).trim();
}

function succeeds(dockerArguments: string[]): boolean {
  try {
    execFileSync("docker", dockerArguments, { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
