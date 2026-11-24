import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * What `pnpm dev` runs: a control plane in development mode (no sign-in, one
 * fixed local user) that creates each thread's sandbox as a directory and a
 * supervisor process on this machine (the local-process provider, which
 * isolates nothing), viewed through the web client's dev server.
 */
export type DevSettings = {
  repositoryRoot: string;
  /** Where each thread's sandbox gets a directory with its workspace and state. */
  sandboxesDirectory: string;
  controlPlanePort: number;
  webClientPort: number;
  agent: AgentChoice;
  /**
   * What the keys users add in Settings are sealed under: the developer's
   * `BARRACK_MODEL_CREDENTIAL_KEY`, or a new one for each run when threads
   * are kept in memory and so are the keys.
   */
  modelCredentialKey: string;
};

/**
 * Each thread's model is chosen on its page, and the key for it added in
 * Settings, as in a deployment; nothing about models is configured here.
 */
export type AgentChoice = { kind: "fake" } | { kind: "pi" };

const defaultControlPlanePort = 8787;
/** Vite's default port, which the control plane allows as a client origin by default. */
const webClientPort = 5173;

/** The fake agent runs unless the developer asks for Pi with `BARRACK_AGENT_HARNESS=pi`. */
export function readDevSettings(
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): DevSettings {
  const { BARRACK_AGENT_HARNESS: harness } = environment;
  return {
    repositoryRoot,
    // Git-ignored, so nothing an agent does there can end up in Barrack's own history.
    sandboxesDirectory: path.join(repositoryRoot, ".barrack-dev", "sandboxes"),
    controlPlanePort: readControlPlanePort(environment),
    webClientPort,
    agent: harness === "pi" ? { kind: "pi" } : { kind: "fake" },
    modelCredentialKey: readModelCredentialKey(environment),
  };
}

/**
 * A key made up for one run would leave keys stored in a database by the
 * previous run sealed under a key nobody has, and the control plane
 * refuses to start over those; so with a database, the developer keeps a
 * key of their own.
 */
function readModelCredentialKey(environment: NodeJS.ProcessEnv): string {
  const { BARRACK_MODEL_CREDENTIAL_KEY: configuredKey, BARRACK_DATABASE_URL: databaseUrl } =
    environment;
  if (configuredKey !== undefined && configuredKey !== "") {
    return configuredKey;
  }
  if (databaseUrl !== undefined && databaseUrl !== "") {
    throw new Error(
      "With BARRACK_DATABASE_URL, also set BARRACK_MODEL_CREDENTIAL_KEY (`openssl rand -base64 32`) and keep it, or the keys added in Settings cannot be read on the next run.",
    );
  }
  return randomBytes(32).toString("base64");
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
