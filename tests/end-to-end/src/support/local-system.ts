import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { testDockerSettings } from "./docker-environment.js";
import { repositoryRoot, ServiceProcess, tsxLoaderUrl } from "./service-process.js";

/** Services get only what they need from the test runner's environment. */
const { PATH: searchPath, HOME: homeDirectory, DOCKER_HOST: dockerHost } = process.env;

/** The browser origin the test clients claim; the control plane is told to allow it. */
export const testClientOrigin = "http://end-to-end-test.localhost";

/**
 * Where the control plane creates threads' sandboxes:
 * - `local-process`: the real supervisor, run from its sources as a child
 *   of the control plane, with no isolation. Fast, and needs no Docker.
 * - `docker`: containers from the sandbox image, with `testDockerSettings`,
 *   which reach the control plane on the host as host.docker.internal.
 */
export type SandboxChoice =
  | {
      kind: "local-process";
      /**
       * The supervisor command, if not the supervisor itself; see
       * `restartable-supervisors.ts`.
       */
      supervisorCommand?: string[];
    }
  | { kind: "docker" };

/**
 * What every sandbox's supervisor runs: the scripted fake agent, or the real
 * Pi with `model`, which must be one the sandbox's Pi is configured to
 * reach (such as the mock model). Pi is kept offline (`PI_OFFLINE`), since
 * a test has no business reaching the internet.
 */
export type AgentChoice = { harness: "fake" } | { harness: "pi"; model: string };

export type ControlPlaneOptions = {
  sandboxes: SandboxChoice;
  /** The fake agent unless said otherwise. */
  agent?: AgentChoice;
  /** The interface to listen on; loopback unless sandboxes must reach it from elsewhere. */
  host?: string;
  /** A free one unless given, as when a control plane is started again in place of one that died. */
  port?: number;
  /** Postgres to keep threads and history in; memory unless given. */
  databaseUrl?: string;
};

export type RunningControlPlane = {
  port: number;
  /** For example `ws://127.0.0.1:41234`. */
  webSocketBaseUrl: string;
  /** For example `http://127.0.0.1:41234`. */
  httpBaseUrl: string;
  process: ServiceProcess;
  /** Stops the control plane, which stops the supervisors it started, and removes what it left. */
  stop(): Promise<void>;
  /**
   * Kills the control plane with SIGKILL, as a host does once its shutdown
   * grace runs out: no connection is closed and no supervisor is stopped.
   */
  kill(): Promise<void>;
};

/**
 * Starts the real control plane from its sources. Its port is picked before
 * it starts, because sandboxes are told the URL to reach it at when they are
 * created.
 */
export async function startControlPlane(
  options: ControlPlaneOptions,
): Promise<RunningControlPlane> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? (await findFreePort(host));
  const sandboxes = await sandboxVariables(options.sandboxes, port);
  const controlPlane = new ServiceProcess("apps/control-plane/src/main.ts", {
    PATH: searchPath,
    HOME: homeDirectory,
    DOCKER_HOST: dockerHost,
    BARRACK_CONTROL_PLANE_HOST: host,
    BARRACK_CONTROL_PLANE_PORT: String(port),
    BARRACK_ALLOWED_CLIENT_ORIGINS: testClientOrigin,
    ...agentVariables(options.agent ?? { harness: "fake" }),
    ...sandboxes.variables,
    ...databaseVariables(options.databaseUrl),
  });
  await controlPlane.waitForLogLine(
    "the control plane to listen",
    ({ msg }) => msg === "Control plane listening",
  );
  return {
    port,
    webSocketBaseUrl: `ws://${host}:${port}`,
    httpBaseUrl: `http://${host}:${port}`,
    process: controlPlane,
    async stop() {
      await controlPlane.stop();
      await sandboxes.removeLeftovers();
    },
    async kill() {
      await controlPlane.kill();
    },
  };
}

function databaseVariables(databaseUrl: string | undefined): NodeJS.ProcessEnv {
  if (databaseUrl === undefined) {
    return {};
  }
  // The test database runs on this machine.
  return { BARRACK_DATABASE_URL: databaseUrl, BARRACK_DATABASE_TLS: "disable" };
}

function agentVariables(agent: AgentChoice): NodeJS.ProcessEnv {
  if (agent.harness === "fake") {
    return { BARRACK_AGENT_HARNESS: "fake" };
  }
  return { BARRACK_AGENT_HARNESS: "pi", BARRACK_MODEL: agent.model, PI_OFFLINE: "1" };
}

async function sandboxVariables(
  sandboxes: SandboxChoice,
  port: number,
): Promise<{ variables: NodeJS.ProcessEnv; removeLeftovers: () => Promise<void> }> {
  if (sandboxes.kind === "docker") {
    return {
      variables: {
        BARRACK_SANDBOX_PROVIDER: "docker",
        BARRACK_DOCKER_IMAGE: testDockerSettings.image,
        BARRACK_DOCKER_CPUS: String(testDockerSettings.cpuLimit),
        BARRACK_DOCKER_MEMORY_MEBIBYTES: String(testDockerSettings.memoryLimitInMebibytes),
        BARRACK_DOCKER_PROCESS_LIMIT: String(testDockerSettings.processLimit),
        BARRACK_DOCKER_STOP_TIMEOUT_SECONDS: String(testDockerSettings.stopTimeoutInSeconds),
        BARRACK_SANDBOX_CONTROL_PLANE_URL: `ws://host.docker.internal:${port}`,
      },
      removeLeftovers: async () => undefined,
    };
  }
  const sandboxesDirectory = await mkdtemp(path.join(tmpdir(), "barrack-end-to-end-sandboxes-"));
  return {
    variables: {
      BARRACK_SANDBOX_PROVIDER: "local-process",
      BARRACK_ALLOW_UNISOLATED_SANDBOXES: "development-only",
      BARRACK_LOCAL_SANDBOX_DIRECTORY: sandboxesDirectory,
      BARRACK_LOCAL_SUPERVISOR_COMMAND: JSON.stringify(
        sandboxes.supervisorCommand ?? [
          process.execPath,
          "--import",
          tsxLoaderUrl,
          path.join(repositoryRoot, "apps/sandbox-supervisor/src/main.ts"),
        ],
      ),
      BARRACK_SANDBOX_CONTROL_PLANE_URL: `ws://127.0.0.1:${port}`,
    },
    removeLeftovers: () => rm(sandboxesDirectory, { recursive: true, force: true }),
  };
}

/**
 * A port nothing is listening on right now, found by letting the operating
 * system pick one and releasing it. Another process could take it in the
 * moment before the control plane does; the control plane would then fail
 * to start and say so.
 */
function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("Could not find a free port."));
          return;
        }
        resolve(address.port);
      });
    });
  });
}
