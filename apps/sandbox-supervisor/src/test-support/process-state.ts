import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The stand-in for a hung Pi; see the file itself. */
export const unresponsivePiPath = fileURLToPath(new URL("unresponsive-pi.mjs", import.meta.url));

/**
 * Whether a process is still running. A killed process whose parent has not
 * collected it yet is a zombie, which `kill(pid, 0)` still finds, so this
 * asks `ps` for the process's state instead.
 */
export function isProcessRunning(processId: number): boolean {
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(processId)], {
      encoding: "utf8",
    });
    return !state.trim().startsWith("Z");
  } catch {
    // ps exits non-zero when no such process exists.
    return false;
  }
}
