import type { BuiltSnapshot } from "./snapshot-build.js";

/**
 * What the command prints. Nothing it prints may carry the API key, so
 * every line of Daytona's that is passed on is cleared of it first, in case
 * an error or a build log ever quotes a request's headers.
 */
export function withoutApiKey(text: string, apiKey: string): string {
  return apiKey === "" ? text : text.replaceAll(apiKey, "[DAYTONA_API_KEY]");
}

export function describeBuildStart(snapshotName: string, commit: string): string {
  return `Building snapshot ${snapshotName} from commit ${commit} with Daytona's builder. Uncommitted changes are not part of it.`;
}

export function describeActiveSnapshot(snapshot: BuiltSnapshot): string {
  const size = snapshot.size === null ? "size not reported" : `${snapshot.size} GB`;
  const entrypoint =
    snapshot.entrypoint === null
      ? "no entrypoint reported"
      : `entrypoint ${snapshot.entrypoint.join(" ")}`;
  return `Snapshot ${snapshot.name} is ${snapshot.state}: ${size}, ${entrypoint}. Set BARRACK_DAYTONA_SNAPSHOT=${snapshot.name} on the control plane.`;
}

/**
 * Daytona answers 403 when the key lacks a permission; creating a snapshot
 * needs `write:snapshots`, which the control plane's own key (only
 * `write:sandboxes` and `delete:sandboxes`) does not have.
 */
export function describeFailedBuild(snapshotName: string, error: unknown, apiKey: string): string {
  const reason = withoutApiKey(error instanceof Error ? error.message : String(error), apiKey);
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  const hint =
    statusCode === 403
      ? " Daytona refused the key: building a snapshot needs a key with write:snapshots."
      : "";
  return `Snapshot ${snapshotName} was not built: ${reason}${hint}`;
}
