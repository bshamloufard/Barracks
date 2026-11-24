import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * What `pnpm dev` runs: a control plane that creates each thread's sandbox
 * as a directory and a supervisor process on this machine (the
 * local-process provider, which isolates nothing), viewed through the web
 * client's dev server.
 */
export type DevSettings = {
  repositoryRoot: string;
  /** Where each thread's sandbox gets a directory with its workspace and state. */
  sandboxesDirectory: string;
  controlPlanePort: number;
  webClientPort: number;
  agent: AgentChoice;
};

/** The model is in Pi's `provider/model` form. */
export type AgentChoice = { kind: "fake" } | { kind: "pi"; model: string };

const defaultControlPlanePort = 8787;
/** Vite's default port, which the control plane allows as a client origin by default. */
const webClientPort = 5173;

/** The fake agent runs unless the developer names a model, which opts in to the real Pi agent. */
export function readDevSettings(
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): DevSettings {
  const { BARRACK_MODEL: model } = environment;
  return {
    repositoryRoot,
    // Git-ignored, so nothing an agent does there can end up in Barrack's own history.
    sandboxesDirectory: path.join(repositoryRoot, ".barrack-dev", "sandboxes"),
    controlPlanePort: readControlPlanePort(environment),
    webClientPort,
    agent: model === undefined || model === "" ? { kind: "fake" } : { kind: "pi", model },
  };
}

export async function prepareSandboxesDirectory(settings: DevSettings): Promise<void> {
  await mkdir(settings.sandboxesDirectory, { recursive: true });
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
