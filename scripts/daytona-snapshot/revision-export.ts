import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type RevisionExport = {
  /** The full commit exported. */
  commit: string;
  /** The sandbox image's Dockerfile, at the root of the export. */
  dockerfilePath: string;
};

/**
 * Writes the committed files of `revision` (nothing uncommitted, nothing
 * ignored, no `node_modules` or build output) to `exportDirectory`, and puts
 * the sandbox image's Dockerfile at its root. Daytona's `Image.fromDockerfile`
 * uploads the files the Dockerfile's `COPY` lines name, resolved against the
 * Dockerfile's own directory, while the Dockerfile names them from the
 * repository root, as `docker build --file sandbox-image/Dockerfile .` reads
 * them. The root's own Dockerfile, the control plane's, is replaced in the
 * export, which is the export's only use of that name.
 */
export async function exportRevisionForDaytona(
  repositoryRoot: string,
  exportDirectory: string,
  revision = "HEAD",
): Promise<RevisionExport> {
  const { stdout } = await run("git", [
    "-C",
    repositoryRoot,
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]);
  const commit = stdout.trim();
  await mkdir(exportDirectory, { recursive: true });
  const archivePath = `${exportDirectory}.tar`;
  await run("git", [
    "-C",
    repositoryRoot,
    "archive",
    "--format=tar",
    "--output",
    archivePath,
    commit,
  ]);
  await run("tar", ["-x", "-f", archivePath, "-C", exportDirectory]);
  const dockerfilePath = path.join(exportDirectory, "Dockerfile");
  await copyFile(path.join(exportDirectory, "sandbox-image", "Dockerfile"), dockerfilePath);
  return { commit, dockerfilePath };
}
