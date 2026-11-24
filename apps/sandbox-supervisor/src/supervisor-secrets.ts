import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

/**
 * Reads the secrets the sandbox provider handed over as files, one per
 * secret, named after it, in `BARRACK_SUPERVISOR_SECRETS_DIRECTORY`; today
 * that is the supervisor's token alone. They are files because a sandbox's
 * environment reaches every process started in it, through `docker exec` or
 * a provider's command interface, whoever it runs as, and is shown to anyone
 * who can inspect the sandbox; a file stays where its mode puts it, and
 * outlives a stop and a start.
 *
 * The directory and each file must belong to this user and be closed to
 * everyone else, or the supervisor refuses to start: a provider that left a
 * secret where the agent can read it must be noticed, not used. Each file is
 * opened without following a link, and checked once open, so what is checked
 * is what is read.
 */

export const supervisorTokenSecretName = "BARRACK_SUPERVISOR_TOKEN";

/** A token is 64 hexadecimal characters; anything near this is not one. */
const longestSecretInBytes = 4096;

export type SupervisorSecrets = { supervisorToken: string };

export type SupervisorSecretsResult =
  | { ok: true; secrets: SupervisorSecrets }
  | { ok: false; problems: string[] };

export async function readSupervisorSecrets(directory: string): Promise<SupervisorSecretsResult> {
  const directoryProblem = await checkDirectory(directory);
  if (directoryProblem !== undefined) {
    return { ok: false, problems: [directoryProblem] };
  }
  const token = await readSecretFile(path.join(directory, supervisorTokenSecretName));
  return token.ok
    ? { ok: true, secrets: { supervisorToken: token.value } }
    : { ok: false, problems: [token.problem] };
}

async function checkDirectory(directory: string): Promise<string | undefined> {
  const prefix = `BARRACK_SUPERVISOR_SECRETS_DIRECTORY: ${directory}`;
  let directoryStats: Stats;
  try {
    directoryStats = await lstat(directory);
  } catch (error) {
    return `${prefix} cannot be read (${describeError(error)})`;
  }
  if (!directoryStats.isDirectory()) {
    return `${prefix} is not a directory`;
  }
  return describeExposure(prefix, directoryStats, "directory");
}

type SecretFileResult = { ok: true; value: string } | { ok: false; problem: string };

async function readSecretFile(filePath: string): Promise<SecretFileResult> {
  const fail = (problem: string): SecretFileResult => ({ ok: false, problem });
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return isMissingFileError(error)
      ? fail(
          `${filePath} does not exist: the sandbox provider did not hand this supervisor its token`,
        )
      : fail(`${filePath} cannot be opened (${describeError(error)})`);
  }
  try {
    const fileStats = await file.stat();
    const exposure = describeExposure(filePath, fileStats, "file");
    if (!fileStats.isFile() || exposure !== undefined) {
      return fail(exposure ?? `${filePath} is not a regular file`);
    }
    if (fileStats.size === 0 || fileStats.size > longestSecretInBytes) {
      return fail(`${filePath} is empty or far too long to be a token`);
    }
    return { ok: true, value: await file.readFile("utf8") };
  } finally {
    await file.close();
  }
}

/** Why another user could reach it, or undefined if only this one can. */
function describeExposure(
  name: string,
  stats: Stats,
  kind: "directory" | "file",
): string | undefined {
  const ownUserId = process.getuid?.();
  if (ownUserId !== undefined && stats.uid !== ownUserId) {
    return `${name} belongs to user ${stats.uid}, not to this supervisor's user (${ownUserId})`;
  }
  if ((stats.mode & 0o077) !== 0) {
    const mode = (stats.mode & 0o777).toString(8).padStart(4, "0");
    return `${name} is mode ${mode}, so other users can reach it; the ${kind} must be closed to all but its owner`;
  }
  return undefined;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function describeError(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : String(error);
}
