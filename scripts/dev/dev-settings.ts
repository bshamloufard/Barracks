import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/**
 * What `pnpm dev` runs: one thread, served by a control plane and a sandbox
 * supervisor on this machine, viewed through the web client's dev server.
 */
export type LocalThreadSettings = {
  repositoryRoot: string;
  /** The thread the web page shows when it is opened without `?thread=`. */
  threadId: string;
  /** Freshly generated for every run and shared by the control plane and the supervisor only. */
  supervisorToken: string;
  controlPlanePort: number;
  webClientPort: number;
  agent: AgentChoice;
};

export type AgentChoice =
  | { kind: "fake" }
  | {
      kind: "pi";
      /** In Pi's `provider/model` form. */
      model: string;
      workspaceDirectory: string;
      stateDirectory: string;
      /** True when the workspace is the default one that `pnpm dev` looks after. */
      isDefaultWorkspace: boolean;
    };

const defaultControlPlanePort = 8787;
/** Vite's default port, which the control plane allows as a client origin by default. */
const webClientPort = 5173;
/** Git-ignored, so nothing the agent does there can end up in Barrack's own history. */
const localDirectoryName = ".barrack-dev";

/**
 * The fake agent runs unless the developer names a model, which opts in to
 * the real Pi agent. The developer's own variables can move Pi's workspace
 * and state elsewhere; otherwise both live under `.barrack-dev/`.
 */
export function readLocalThreadSettings(
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): LocalThreadSettings {
  return {
    repositoryRoot,
    threadId: "local",
    supervisorToken: randomBytes(32).toString("hex"),
    controlPlanePort: readControlPlanePort(environment),
    webClientPort,
    agent: chooseAgent(environment, repositoryRoot),
  };
}

function chooseAgent(environment: NodeJS.ProcessEnv, repositoryRoot: string): AgentChoice {
  const { BARRACK_MODEL: model } = environment;
  if (model === undefined || model === "") {
    return { kind: "fake" };
  }
  const localDirectory = path.join(repositoryRoot, localDirectoryName);
  const {
    BARRACK_WORKSPACE_DIRECTORY: workspaceDirectory,
    BARRACK_STATE_DIRECTORY: stateDirectory,
  } = environment;
  return {
    kind: "pi",
    model,
    workspaceDirectory: path.resolve(workspaceDirectory ?? path.join(localDirectory, "workspace")),
    stateDirectory: path.resolve(stateDirectory ?? path.join(localDirectory, "state")),
    isDefaultWorkspace: workspaceDirectory === undefined,
  };
}

function readControlPlanePort(environment: NodeJS.ProcessEnv): number {
  const { BARRACK_CONTROL_PLANE_PORT: portText } = environment;
  if (portText === undefined) {
    return defaultControlPlanePort;
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`BARRACK_CONTROL_PLANE_PORT must be a port number, got "${portText}".`);
  }
  return port;
}

/**
 * Creates Pi's directories. The default workspace sits inside this
 * repository, so it is made a Git repository of its own: otherwise Git
 * commands the agent runs there would act on Barrack's repository instead.
 */
export async function prepareAgentDirectories(agent: AgentChoice): Promise<void> {
  if (agent.kind === "fake") {
    return;
  }
  await mkdir(agent.workspaceDirectory, { recursive: true });
  await mkdir(agent.stateDirectory, { recursive: true });
  const needsOwnRepository =
    agent.isDefaultWorkspace && !existsSync(path.join(agent.workspaceDirectory, ".git"));
  if (needsOwnRepository) {
    await promisify(execFile)("git", ["init", "--quiet"], { cwd: agent.workspaceDirectory });
  }
}
