import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportRevisionForDaytona } from "./revision-export.js";
import type { SnapshotBuilder } from "./snapshot-build.js";
import {
  describeActiveSnapshot,
  describeBuildStart,
  describeFailedBuild,
  withoutApiKey,
} from "./snapshot-outcome.js";
import { readSnapshotRequest, usage } from "./snapshot-request.js";

export type SnapshotCommandDependencies = {
  repositoryRoot: string;
  createBuilder: (apiKey: string, target: string | undefined) => SnapshotBuilder;
  print: (line: string) => void;
};

/**
 * The command, start to end: reads what it is asked, exports the current
 * commit, has Daytona build it, says how that ended, and returns the exit
 * code. The export is removed whatever happens.
 */
export async function runSnapshotCommand(
  commandArguments: readonly string[],
  environment: NodeJS.ProcessEnv,
  dependencies: SnapshotCommandDependencies,
): Promise<number> {
  const { print } = dependencies;
  const reading = readSnapshotRequest(commandArguments, environment);
  if (reading.kind === "help") {
    print(usage);
    return 0;
  }
  if (reading.kind === "refused") {
    for (const problem of reading.problems) {
      print(problem);
    }
    print(usage);
    return 2;
  }
  const { snapshotName, apiKey, target } = reading.request;
  const workDirectory = await mkdtemp(path.join(tmpdir(), "barrack-daytona-snapshot-"));
  try {
    const { commit, dockerfilePath } = await exportRevisionForDaytona(
      dependencies.repositoryRoot,
      path.join(workDirectory, "revision"),
    );
    print(describeBuildStart(snapshotName, commit));
    const build = dependencies.createBuilder(apiKey, target);
    const snapshot = await build(snapshotName, dockerfilePath, (line) =>
      print(withoutApiKey(line, apiKey)),
    );
    print(describeActiveSnapshot(snapshot));
    return 0;
  } catch (error) {
    print(describeFailedBuild(snapshotName, error, apiKey));
    return 1;
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}
