import { fileURLToPath } from "node:url";
import { createDaytonaSnapshotBuilder } from "./snapshot-build.js";
import { runSnapshotCommand } from "./snapshot-command.js";

/**
 * `pnpm sandbox-image:daytona-snapshot <name>`: builds the sandbox image as a
 * Daytona snapshot with Daytona's own builder, from the current commit. See
 * `usage` in `snapshot-request.ts` and the deployment guide's step 2.
 */
process.exitCode = await runSnapshotCommand(process.argv.slice(2), process.env, {
  repositoryRoot: fileURLToPath(new URL("../../", import.meta.url)),
  createBuilder: createDaytonaSnapshotBuilder,
  print: (line) => console.log(line),
});
