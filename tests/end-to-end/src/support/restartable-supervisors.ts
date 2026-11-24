import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { repositoryRoot, tsxLoaderUrl } from "./service-process.js";

/**
 * Drives the stand-in sandboxes of `restartable-supervisor.ts`: kills a
 * thread's supervisor outright, as a crash or a dying sandbox would, starts
 * it again, and stops every one of them at the end, since a supervisor
 * outlives a control plane killed with SIGKILL.
 */

type SupervisorRecord = { wrapperProcessId: number; supervisorProcessId: number | null };

const waitTimeoutInMilliseconds = 20_000;
const pollIntervalInMilliseconds = 50;

/** The local-process provider's supervisor command, wrapped so a test can kill and restart it. */
export function restartableSupervisorCommand(recordDirectory: string): string[] {
  return [
    process.execPath,
    "--import",
    tsxLoaderUrl,
    path.join(repositoryRoot, "tests/end-to-end/src/support/restartable-supervisor.ts"),
    recordDirectory,
    process.execPath,
    "--import",
    tsxLoaderUrl,
    path.join(repositoryRoot, "apps/sandbox-supervisor/src/main.ts"),
  ];
}

export class RestartableSupervisors {
  readonly #recordDirectory: string;

  constructor(recordDirectory: string) {
    this.#recordDirectory = recordDirectory;
  }

  /** Kills the thread's supervisor with SIGKILL, so it can neither finish its run nor say goodbye. */
  async kill(threadId: string): Promise<void> {
    const supervisorProcessId = await this.#waitForSupervisor(threadId);
    process.kill(supervisorProcessId, "SIGKILL");
    await this.#waitUntil(
      threadId,
      "its supervisor has exited",
      (record) => record.supervisorProcessId === null,
    );
  }

  /** Starts the thread's supervisor again, in the same sandbox directory and environment. */
  async restart(threadId: string): Promise<void> {
    const record = await this.#readRecord(threadId);
    if (record === undefined) {
      throw new Error(`No sandbox was started for thread ${threadId}.`);
    }
    process.kill(record.wrapperProcessId, "SIGHUP");
    await this.#waitForSupervisor(threadId);
  }

  /** Stops every stand-in sandbox, and the supervisor in it, that is still running. */
  async stopAll(): Promise<void> {
    const fileNames = await readdir(this.#recordDirectory);
    for (const fileName of fileNames.filter((name) => name.endsWith(".json"))) {
      const record = await this.#readRecord(path.basename(fileName, ".json"));
      if (record !== undefined) {
        signalIfRunning(record.wrapperProcessId, "SIGTERM");
      }
    }
  }

  async #waitForSupervisor(threadId: string): Promise<number> {
    const record = await this.#waitUntil(
      threadId,
      "its supervisor is running",
      (current) => current.supervisorProcessId !== null,
    );
    return record.supervisorProcessId ?? 0;
  }

  async #waitUntil(
    threadId: string,
    description: string,
    isSatisfied: (record: SupervisorRecord) => boolean,
  ): Promise<SupervisorRecord> {
    const deadline = Date.now() + waitTimeoutInMilliseconds;
    while (Date.now() < deadline) {
      const record = await this.#readRecord(threadId);
      if (record !== undefined && isSatisfied(record)) {
        return record;
      }
      await sleep(pollIntervalInMilliseconds);
    }
    throw new Error(`Timed out waiting until thread ${threadId}'s sandbox says ${description}.`);
  }

  async #readRecord(threadId: string): Promise<SupervisorRecord | undefined> {
    try {
      const text = await readFile(path.join(this.#recordDirectory, `${threadId}.json`), "utf8");
      return JSON.parse(text);
    } catch {
      // Not written yet, or caught half-written; the caller polls again.
      return undefined;
    }
  }
}

function signalIfRunning(processId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(processId, signal);
  } catch {
    // It has already exited.
  }
}
