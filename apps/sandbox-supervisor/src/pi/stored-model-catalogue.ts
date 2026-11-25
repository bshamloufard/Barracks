import path from "node:path";
import type { AgentProcessLauncher } from "../agent-process/agent-process-launcher.js";

/**
 * Pi keeps a model catalogue fetched from pi.dev in `models-store.json` in
 * its agent directory, and lays it over its built-in catalogue whenever it
 * starts, even offline. The catalogue decides what Pi puts in a request
 * (which fallbacks, sampling settings and tool kinds it sends), and the
 * control plane's model proxy relays only requests shaped like the pinned
 * Pi's with its built-in catalogue (`agent-request-shapes.json` in
 * `@barrack/model-catalogue`). The supervisor runs Pi offline, so Pi never
 * fetches one (`pi-environment.ts`); this removes one left by an earlier
 * Pi that was not, or written by anything else in the sandbox, before each
 * start.
 *
 * Removed as the agent, who owns the directory: the supervisor may only
 * pass through it (see the sandbox image's README).
 */
export const storedModelCatalogueFileName = "models-store.json";

export function removeStoredModelCatalogue(
  launcher: AgentProcessLauncher,
  agentDirectory: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = launcher.launchCommand({
      executable: process.execPath,
      arguments: [
        "-e",
        'require("node:fs").rmSync(process.argv[1], { force: true })',
        path.join(agentDirectory, storedModelCatalogueFileName),
      ],
      workingDirectory: agentDirectory,
      // Nothing of the supervisor's: the program needs no variable at all.
      environment: {},
    });
    let standardError = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk: Buffer) => {
      standardError = `${standardError}${chunk.toString()}`.slice(-2_000);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Removing Pi's stored model catalogue failed with exit code ${exitCode}: ${standardError.trim()}`,
        ),
      );
    });
    child.stdin.end();
  });
}
