import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * What the local-process provider keeps on disk about each sandbox, in the
 * sandbox's own directory, so that a control plane started again finds the
 * sandboxes an earlier one made, and whether their supervisors still run:
 *
 * - `sandbox-record.json`: the thread and the supervisor's environment, so
 *   that the supervisor can be started again with it. The environment holds
 *   the supervisor's token; the file is readable by its owner only, though
 *   on this provider the agent runs as that same user and can read it
 *   anyway (see the provider's own comment).
 * - `supervisor.pid`: the process identifier of the running supervisor,
 *   written once it has started. Whoever stops it first renames the file
 *   `supervisor-stopping.pid`, then signals the process, then removes the
 *   file once it has exited. A `supervisor.pid` naming a process that is
 *   gone therefore means the supervisor exited by itself, and a stop cut
 *   short (its control plane killed) leaves a file the next stop finds.
 */

const recordFileName = "sandbox-record.json";
const supervisorProcessFileName = "supervisor.pid";
const stoppingSupervisorProcessFileName = "supervisor-stopping.pid";

/**
 * Identifiers the provider mints are `local-` and a UUID. Anything else
 * cannot name one of its directories, and is never joined into a path, so
 * an identifier cannot reach outside the sandboxes directory.
 */
const sandboxIdPattern = /^local-[A-Za-z0-9-]{1,64}$/;

const sandboxRecordSchema = z.strictObject({
  sandboxId: z.string().regex(sandboxIdPattern),
  threadId: z.string().min(1),
  supervisorEnvironment: z.record(z.string(), z.string()),
});

export type LocalSandboxRecord = z.infer<typeof sandboxRecordSchema>;

export function isLocalSandboxId(sandboxId: string): boolean {
  return sandboxIdPattern.test(sandboxId);
}

export async function writeSandboxRecord(
  sandboxDirectory: string,
  record: LocalSandboxRecord,
): Promise<void> {
  await writeFile(path.join(sandboxDirectory, recordFileName), JSON.stringify(record), {
    mode: 0o600,
  });
}

/** The record in a sandbox's directory, or undefined if there is none (no such sandbox). */
export async function readSandboxRecord(
  sandboxDirectory: string,
): Promise<LocalSandboxRecord | undefined> {
  const text = await readFileIfPresent(path.join(sandboxDirectory, recordFileName));
  if (text === undefined) {
    return undefined;
  }
  return sandboxRecordSchema.parse(JSON.parse(text));
}

/** Every sandbox recorded in the sandboxes directory, whichever process made it. */
export async function readEverySandboxRecord(
  sandboxesDirectory: string,
): Promise<LocalSandboxRecord[]> {
  const entries = await readdir(sandboxesDirectory).catch((error: unknown) => {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  });
  const records = await Promise.all(
    entries
      .filter(isLocalSandboxId)
      .map((entry) => readSandboxRecord(path.join(sandboxesDirectory, entry))),
  );
  return records.filter((record) => record !== undefined);
}

export async function writeSupervisorProcessId(
  sandboxDirectory: string,
  processId: number,
): Promise<void> {
  await writeFile(path.join(sandboxDirectory, supervisorProcessFileName), String(processId));
}

/** The supervisor last launched, and whether a stop of it has begun; undefined if none runs or ran. */
export type SupervisorProcess = { processId: number; isBeingStopped: boolean };

export async function readSupervisorProcess(
  sandboxDirectory: string,
): Promise<SupervisorProcess | undefined> {
  const running = await readProcessId(path.join(sandboxDirectory, supervisorProcessFileName));
  if (running !== undefined) {
    return { processId: running, isBeingStopped: false };
  }
  const stopping = await readProcessId(
    path.join(sandboxDirectory, stoppingSupervisorProcessFileName),
  );
  return stopping === undefined ? undefined : { processId: stopping, isBeingStopped: true };
}

/** Notes that the supervisor is about to be signalled to stop; see the comment at the top. */
export async function markSupervisorBeingStopped(sandboxDirectory: string): Promise<void> {
  try {
    await rename(
      path.join(sandboxDirectory, supervisorProcessFileName),
      path.join(sandboxDirectory, stoppingSupervisorProcessFileName),
    );
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

export async function removeSupervisorProcessId(sandboxDirectory: string): Promise<void> {
  await rm(path.join(sandboxDirectory, supervisorProcessFileName), { force: true });
  await rm(path.join(sandboxDirectory, stoppingSupervisorProcessFileName), { force: true });
}

async function readProcessId(filePath: string): Promise<number | undefined> {
  const text = await readFileIfPresent(filePath);
  const processId = Number(text);
  return text === undefined || !Number.isSafeInteger(processId) || processId <= 0
    ? undefined
    : processId;
}

/** Whether a process with this identifier exists (signal 0 checks without signalling). */
export function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to another user.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function readFileIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
