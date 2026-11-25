import { Daytona } from "@daytona/sdk";
import { Image } from "@daytona/sdk/v0";

/** What Daytona reports of a snapshot it built, as far as the command says. */
export type BuiltSnapshot = {
  name: string;
  state: string;
  /** In GB, as Daytona reports it; null until known. */
  size: number | null;
  entrypoint: string[] | null;
};

export type SnapshotBuilder = (
  snapshotName: string,
  dockerfilePath: string,
  onLogs: (line: string) => void,
) => Promise<BuiltSnapshot>;

/**
 * What every sandbox made from the snapshot gets: what an agent needs, and
 * within Daytona Tier 1's limits for one sandbox (4 vCPU, 8 GiB, 10 GiB).
 */
const sandboxResources = { cpu: 2, memory: 4, disk: 8 };

/**
 * Builds through Daytona's generally available platform (the SDK's `v0`),
 * as the control plane creates sandboxes. `create` uploads the files the
 * Dockerfile's `COPY` lines name, has Daytona's builder build the image,
 * and waits until the snapshot is active, or throws once it has failed.
 */
export function createDaytonaSnapshotBuilder(
  apiKey: string,
  target: string | undefined,
): SnapshotBuilder {
  const daytona = new Daytona({ apiKey, ...(target === undefined ? {} : { target }) });
  return async (snapshotName, dockerfilePath, onLogs) => {
    try {
      return await daytona.v0.snapshot.create(
        {
          name: snapshotName,
          image: Image.fromDockerfile(dockerfilePath),
          resources: sandboxResources,
        },
        { onLogs },
      );
    } finally {
      await daytona.close();
    }
  };
}
