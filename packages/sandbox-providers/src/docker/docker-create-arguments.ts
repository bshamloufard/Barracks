import type { SandboxCreationRequest } from "../sandbox-provider.js";
import {
  sandboxImageSecretsDirectory,
  supervisorSecretsDirectoryVariable,
} from "../supervisor-secrets.js";
import { sandboxLabel, threadIdLabel } from "./docker-container.js";

export type DockerProviderSettings = {
  /** The sandbox image, e.g. `barrack-sandbox:dev`; see `sandbox-image/`. */
  image: string;
  /** How many CPUs each sandbox may use (`docker run --cpus`). */
  cpuLimit: number;
  /** How much memory each sandbox may use, with no swap beyond it. */
  memoryLimitInMebibytes: number;
  /** How many processes each sandbox may run at once, which stops a fork bomb taking the host down. */
  processLimit: number;
  /** How long a stopping supervisor gets to finish before it is killed. */
  stopTimeoutInSeconds: number;
  /**
   * Ports inside the sandbox that `getServiceAddress` can hand out. Each is
   * published on the host's loopback interface only, at a port Docker picks.
   * Empty by default: nothing is published until a feature needs it.
   */
  servicePorts: readonly number[];
  /** The docker executable; `docker` on the search path unless set. */
  dockerExecutable: string;
  /**
   * The Docker network sandboxes join, instead of Docker's default bridge.
   * A control plane running in a container on the same network is then
   * reachable by its name there, and other containers kept off that network,
   * such as its database, are not reachable at all (see compose.yaml).
   * Optional, so that settings written before it existed stay valid.
   */
  network?: string | undefined;
};

/**
 * Lets the supervisor reach a control plane running on the Docker host as
 * `host.docker.internal`, which Docker Desktop provides by itself and Linux
 * engines provide through this mapping to the host's gateway address.
 * https://docs.docker.com/reference/cli/docker/container/run/#add-host
 */
export const hostAlias = "host.docker.internal";

export function containerNameFor(threadId: string): string {
  return `barrack-thread-${threadId}`;
}

/**
 * The supervisor's plain settings, and where its secrets are. The secrets
 * themselves are never in a container's environment (see `create`).
 */
export function buildContainerEnvironment(request: SandboxCreationRequest): Record<string, string> {
  return {
    ...request.supervisorEnvironment,
    [supervisorSecretsDirectoryVariable]: sandboxImageSecretsDirectory,
  };
}

/**
 * The arguments of the `docker container create` that makes a thread's
 * sandbox. The environment (`buildContainerEnvironment`) is passed as bare
 * `--env NAME` flags, which make the CLI copy each value from its own
 * environment, so no value appears in the process list either.
 */
export function buildCreateArguments(
  settings: DockerProviderSettings,
  request: SandboxCreationRequest,
): string[] {
  const environmentArguments = Object.keys(buildContainerEnvironment(request))
    .sort()
    .flatMap((name) => ["--env", name]);
  const networkArguments = settings.network === undefined ? [] : ["--network", settings.network];
  const publishArguments = settings.servicePorts.flatMap((port) => [
    "--publish",
    `127.0.0.1::${port}`,
  ]);
  return [
    "container",
    "create",
    "--name",
    containerNameFor(request.threadId),
    "--label",
    `${sandboxLabel}=true`,
    "--label",
    `${threadIdLabel}=${request.threadId}`,
    "--add-host",
    `${hostAlias}:host-gateway`,
    "--cpus",
    String(settings.cpuLimit),
    "--memory",
    `${settings.memoryLimitInMebibytes}m`,
    "--memory-swap",
    `${settings.memoryLimitInMebibytes}m`,
    "--pids-limit",
    String(settings.processLimit),
    "--stop-timeout",
    String(settings.stopTimeoutInSeconds),
    // Nothing in the sandbox runs as root, so it needs no capabilities beyond
    // the two the supervisor will use to start the agent as a separate user
    // (see sandbox-image/README.md). Those two must stay in the bounding set
    // for that, and `no-new-privileges` would stop the supervisor's binary
    // from receiving them, so it is not set.
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    ...environmentArguments,
    ...networkArguments,
    ...publishArguments,
    settings.image,
  ];
}

/**
 * Names that the docker CLI itself reads from its environment. A supervisor
 * variable with one of these names would change how the CLI behaves when it
 * is put into the CLI's environment, so such names are refused.
 */
export function isReservedForDockerCli(environmentVariableName: string): boolean {
  return (
    environmentVariableName.startsWith("DOCKER_") ||
    environmentVariableName === "PATH" ||
    environmentVariableName === "HOME"
  );
}
