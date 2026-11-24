/**
 * Where Pi and what it needs are on disk: its RPC entry point, the computer
 * tool it loads as an extension, and the directories under the state
 * directory that hold its credentials, settings and sessions.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolvePiEntryPointPath(): string {
  // The package exports its RPC entry point under the `import` condition
  // only, so `require.resolve` cannot find it.
  return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
}

/**
 * The computer tool, as an extension Pi loads (`--extension`). Pi compiles
 * extensions itself, so this is the built file in the image and the source
 * file when the supervisor runs from its sources.
 */
export function resolveComputerUseExtensionPath(): string {
  const fileExtension = path.extname(fileURLToPath(import.meta.url));
  return fileURLToPath(
    new URL(`./computer-use/computer-use-extension${fileExtension}`, import.meta.url),
  );
}

export function getPiDirectories(stateDirectory: string) {
  return {
    agentDirectory: path.join(stateDirectory, "pi", "agent"),
    sessionDirectory: path.join(stateDirectory, "pi", "sessions"),
  };
}

/** Makes Pi's agent and session directories, if they are not there yet. */
export async function preparePiDirectories(stateDirectory: string): Promise<void> {
  const { agentDirectory, sessionDirectory } = getPiDirectories(stateDirectory);
  await mkdir(agentDirectory, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
}
