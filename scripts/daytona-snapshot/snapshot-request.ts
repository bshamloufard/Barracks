/** What one run of the command is asked to do, read from its arguments and environment. */
export type SnapshotRequest = {
  snapshotName: string;
  apiKey: string;
  /** Daytona's region, or undefined for the organisation's default. */
  target: string | undefined;
};

export type SnapshotRequestReading =
  | { kind: "request"; request: SnapshotRequest }
  | { kind: "help" }
  | { kind: "refused"; problems: string[] };

export const usage = `Usage: DAYTONA_API_KEY=<key with write:snapshots> pnpm sandbox-image:daytona-snapshot <snapshot name>

Builds the sandbox image from the current commit with Daytona's own builder, as a
snapshot of that name (2 vCPU, 4 GiB of memory, 8 GiB of disk), waits until it is
active or has failed, and says which. Give each build a new name, such as
barrack-sandbox-$(git rev-parse --short HEAD), and set it as BARRACK_DAYTONA_SNAPSHOT.
DAYTONA_TARGET names a region other than the organisation's default.`;

/** Never echoes the key: a problem with it is named, not quoted. */
export function readSnapshotRequest(
  commandArguments: readonly string[],
  environment: NodeJS.ProcessEnv,
): SnapshotRequestReading {
  if (commandArguments.includes("--help") || commandArguments.includes("-h")) {
    return { kind: "help" };
  }
  const problems: string[] = [];
  const [snapshotName, ...extra] = commandArguments;
  if (snapshotName === undefined || snapshotName.startsWith("-")) {
    problems.push("Name the snapshot to build, as the one argument.");
  } else if (/\s/.test(snapshotName)) {
    problems.push(`A snapshot name has no spaces: "${snapshotName}".`);
  }
  if (extra.length > 0) {
    problems.push(`Only the snapshot's name is taken; also given: ${extra.join(" ")}.`);
  }
  const { DAYTONA_API_KEY: apiKey, DAYTONA_TARGET: target } = environment;
  if (apiKey === undefined || apiKey.trim() === "") {
    problems.push(
      "DAYTONA_API_KEY: is required, a Daytona API key with write:snapshots (not the control plane's key).",
    );
  }
  if (problems.length > 0 || snapshotName === undefined || apiKey === undefined) {
    return { kind: "refused", problems };
  }
  return {
    kind: "request",
    request: { snapshotName, apiKey, target: target === "" ? undefined : target },
  };
}
