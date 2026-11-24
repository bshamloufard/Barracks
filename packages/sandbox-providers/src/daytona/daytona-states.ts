import type { SandboxState, SandboxStatus } from "../sandbox-provider.js";
import type { DaytonaSandboxRecord } from "./daytona-api.js";

/**
 * How Daytona's sandbox states map onto Barrack's. The names are those of
 * the v0 API's `SandboxState` (in `@daytona/api-client`).
 *
 * An archived sandbox is `stopped`: its files are kept in Daytona's object
 * storage, and starting it restores them (more slowly than from `stopped`).
 */
const barrackStateByDaytonaState: Readonly<Record<string, Exclude<SandboxState, "failed">>> = {
  started: "running",
  creating: "starting",
  starting: "starting",
  restoring: "starting",
  pending_build: "starting",
  building_snapshot: "starting",
  pulling_snapshot: "starting",
  stopping: "stopping",
  archiving: "stopping",
  destroying: "stopping",
  stopped: "stopped",
  archived: "stopped",
  destroyed: "missing",
};

const failedDaytonaStates = new Set(["error", "build_failed"]);

export function toSandboxStatus(record: DaytonaSandboxRecord | undefined): SandboxStatus {
  if (record === undefined) {
    return { state: "missing" };
  }
  const daytonaState = record.state ?? "unknown";
  if (failedDaytonaStates.has(daytonaState)) {
    return {
      state: "failed",
      cause: "provider-fault",
      reason: record.errorReason ?? `Daytona reports ${daytonaState}`,
    };
  }
  const state = barrackStateByDaytonaState[daytonaState];
  if (state === undefined) {
    // Barrack never asks for the states left (pausing, resizing, forking,
    // snapshotting and the like), so meeting one means something else is
    // managing the sandbox.
    return {
      state: "failed",
      cause: "provider-fault",
      reason: `Daytona reports the unexpected state "${daytonaState}"`,
    };
  }
  return { state };
}
