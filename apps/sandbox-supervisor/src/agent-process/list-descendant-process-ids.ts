import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runCommand = promisify(execFile);

/**
 * The identifiers of every process descended from `rootProcessId`, read from
 * `ps`, whose output format is the same on Linux and macOS.
 */
export async function listDescendantProcessIds(rootProcessId: number): Promise<number[]> {
  const { stdout } = await runCommand("ps", ["-A", "-o", "pid=", "-o", "ppid="]);
  return findDescendants(rootProcessId, parseProcessTable(stdout));
}

type ProcessParentage = { processId: number; parentProcessId: number };

export function parseProcessTable(psOutput: string): ProcessParentage[] {
  return psOutput
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (fields): fields is [number, number] =>
        fields.length === 2 && fields.every((field) => Number.isInteger(field)),
    )
    .map(([processId, parentProcessId]) => ({ processId, parentProcessId }));
}

export function findDescendants(
  rootProcessId: number,
  processTable: readonly ProcessParentage[],
): number[] {
  const descendants: number[] = [];
  const parentsToVisit = [rootProcessId];
  for (let parent = parentsToVisit.pop(); parent !== undefined; parent = parentsToVisit.pop()) {
    for (const entry of processTable) {
      if (entry.parentProcessId === parent && entry.processId !== rootProcessId) {
        descendants.push(entry.processId);
        parentsToVisit.push(entry.processId);
      }
    }
  }
  return descendants;
}
