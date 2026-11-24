import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  describeSandboxCreation,
  describeServiceAddressLookup,
  validateCreationRequest,
  validateServiceAddressRequest,
} from "../request-validation.js";
import type {
  CreatedSandbox,
  SandboxCreationRequest,
  SandboxProvider,
  SandboxStatus,
  ServiceAddress,
  ServiceAddressRequest,
} from "../sandbox-provider.js";
import {
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
  SandboxRefusedError,
} from "../sandbox-provider-errors.js";
import {
  isLocalSandboxId,
  isProcessAlive,
  type LocalSandboxRecord,
  markSupervisorBeingStopped,
  readEverySandboxRecord,
  readSandboxRecord,
  readSupervisorProcess,
  removeSupervisorProcessId,
  writeSandboxRecord,
  writeSupervisorProcessId,
} from "./local-sandbox-records.js";
import { stopSupervisorsWhenThisProcessExits } from "./supervisors-on-exit.js";

/**
 * NOT A SANDBOX. Runs each thread's supervisor as an ordinary child process
 * of the control plane, on the same machine, as the same user, with no
 * isolation of any kind: the agent can read and change everything that user
 * can, including the other threads' files and the control plane's own
 * environment. It exists so that `pnpm dev` and the fast cross-application
 * tests can create threads without Docker or a cloud account, and the
 * configuration refuses it unless development use is declared explicitly.
 *
 * Each sandbox is a directory of its own, holding the agent's workspace and
 * the supervisor's state, and the supervisor runs with that workspace as
 * its working directory. What "stop keeps the files" means here: stopping
 * ends the supervisor (and with it the agent) and leaves the directory on
 * disk, and starting launches the supervisor again in it.
 *
 * What the provider knows of a sandbox is kept in the sandbox's directory
 * (`local-sandbox-records.ts`), so a control plane started again finds the
 * sandboxes an earlier one made: a supervisor that outlived it (one killed
 * outright runs no exit handler) is reported running and can be stopped,
 * and one that was stopped can be started again. A control plane that exits
 * normally still ends every supervisor it started, which then report as
 * failed, having exited without being stopped.
 */

export type LocalProcessProviderSettings = {
  /** The supervisor's executable and its arguments, e.g. node and its entry point. */
  supervisorCommand: readonly [string, ...string[]];
  /** The directory each sandbox gets a directory of its own in. */
  sandboxesDirectory: string;
  /** How long a stopping supervisor gets to finish before it is killed. */
  stopTimeoutInMilliseconds: number;
};

/**
 * What a sandbox image would provide by itself, taken from the control
 * plane's environment: where to find programs, the user's home, the locale,
 * and the proxy settings a machine behind one needs to reach the model
 * provider. Nothing else of the control plane's environment is passed on.
 */
const hostVariableNames = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

const exitPollIntervalInMilliseconds = 50;

export class LocalProcessSandboxProvider implements SandboxProvider {
  readonly #settings: LocalProcessProviderSettings;
  readonly #hostEnvironment: NodeJS.ProcessEnv;
  /** Supervisors this process launched, by process identifier, until they exit. */
  readonly #launchedSupervisors = new Map<number, ChildProcess>();
  /** How each supervisor that exited without being stopped ended, while this process remembers. */
  readonly #exitDescriptions = new Map<string, string>();
  /** Sandboxes whose supervisor is being launched right now. */
  readonly #launchingSandboxIds = new Set<string>();
  /** Threads whose sandbox is being created right now, so two creations cannot both pass the check. */
  readonly #threadsBeingCreated = new Set<string>();

  constructor(settings: LocalProcessProviderSettings, hostEnvironment = process.env) {
    this.#settings = settings;
    this.#hostEnvironment = hostEnvironment;
  }

  async create(request: SandboxCreationRequest): Promise<CreatedSandbox> {
    validateCreationRequest(request);
    const { threadId } = request;
    if (this.#threadsBeingCreated.has(threadId)) {
      throw new SandboxRefusedError(
        describeSandboxCreation(threadId),
        "a sandbox is already being created for this thread",
      );
    }
    this.#threadsBeingCreated.add(threadId);
    try {
      return await this.#createSandbox(request);
    } finally {
      this.#threadsBeingCreated.delete(threadId);
    }
  }

  async start(sandboxId: string): Promise<void> {
    const attemptedOperation = `start sandbox "${sandboxId}"`;
    const record = await this.#requireRecord(attemptedOperation, sandboxId);
    if ((await this.getStatus(sandboxId)).state === "running") {
      return;
    }
    try {
      await this.#launchSupervisor(record);
    } catch (error) {
      throw new SandboxRefusedError(attemptedOperation, describeFailure(error));
    }
  }

  async stop(sandboxId: string): Promise<void> {
    await this.#requireRecord(`stop sandbox "${sandboxId}"`, sandboxId);
    await this.#stopSupervisor(sandboxId);
  }

  async destroy(sandboxId: string): Promise<void> {
    if (!isLocalSandboxId(sandboxId)) {
      return;
    }
    await this.#stopSupervisor(sandboxId);
    await rm(this.#directoryOf(sandboxId), { recursive: true, force: true });
  }

  /**
   * Read from the sandbox's directory, not this process's memory, so that a
   * control plane started again reports what an earlier one left running.
   */
  async getStatus(sandboxId: string): Promise<SandboxStatus> {
    if (!isLocalSandboxId(sandboxId)) {
      return { state: "missing" };
    }
    if (this.#launchingSandboxIds.has(sandboxId)) {
      return { state: "starting" };
    }
    const directory = this.#directoryOf(sandboxId);
    if ((await readSandboxRecord(directory)) === undefined) {
      return { state: "missing" };
    }
    const supervisor = await readSupervisorProcess(directory);
    if (supervisor === undefined) {
      return { state: "stopped" };
    }
    const isRunning = this.#isSupervisorRunning(supervisor.processId);
    if (supervisor.isBeingStopped) {
      return { state: isRunning ? "stopping" : "stopped" };
    }
    if (isRunning) {
      return { state: "running" };
    }
    return {
      state: "failed",
      reason: this.#exitDescriptions.get(sandboxId) ?? "its supervisor exited by itself",
    };
  }

  /**
   * A service inside a local sandbox listens on the host itself, so its
   * address is the port on the loopback interface. Nothing keeps two
   * sandboxes from wanting the same port.
   */
  async getServiceAddress(request: ServiceAddressRequest): Promise<ServiceAddress> {
    validateServiceAddressRequest(request);
    const attemptedOperation = describeServiceAddressLookup(request);
    await this.#requireRecord(attemptedOperation, request.sandboxId);
    if ((await this.getStatus(request.sandboxId)).state !== "running") {
      throw new SandboxRefusedError(attemptedOperation, "the sandbox is not running");
    }
    return {
      url: `http://127.0.0.1:${request.port}/`,
      expiresAt: undefined,
      reachableBy: "the-sandbox-host-only",
    };
  }

  /** The agent's workspace in a sandbox, or undefined if there is no such sandbox. */
  workspaceDirectoryOf(sandboxId: string): string | undefined {
    if (!isLocalSandboxId(sandboxId)) {
      return undefined;
    }
    const directory = this.#directoryOf(sandboxId);
    return existsSync(directory) ? workspaceDirectoryIn(directory) : undefined;
  }

  async #createSandbox(request: SandboxCreationRequest): Promise<CreatedSandbox> {
    const attemptedOperation = describeSandboxCreation(request.threadId);
    const records = await readEverySandboxRecord(this.#settings.sandboxesDirectory);
    const existing = records.find((record) => record.threadId === request.threadId);
    if (existing !== undefined) {
      throw new SandboxAlreadyExistsError(request.threadId, existing.sandboxId);
    }
    const record: LocalSandboxRecord = {
      sandboxId: `local-${randomUUID()}`,
      threadId: request.threadId,
      supervisorEnvironment: { ...request.supervisorEnvironment },
    };
    const directory = this.#directoryOf(record.sandboxId);
    try {
      await prepareDirectories(directory);
      await writeSandboxRecord(directory, record);
      await this.#launchSupervisor(record);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw new SandboxRefusedError(attemptedOperation, describeFailure(error));
    }
    return { sandboxId: record.sandboxId };
  }

  /**
   * Resolves once the supervisor process has started and its identifier is
   * on disk, or rejects if it could not be started (its executable does not
   * exist, say).
   */
  async #launchSupervisor(record: LocalSandboxRecord): Promise<void> {
    const { sandboxId } = record;
    const directory = this.#directoryOf(sandboxId);
    this.#launchingSandboxIds.add(sandboxId);
    this.#exitDescriptions.delete(sandboxId);
    try {
      await removeSupervisorProcessId(directory);
      const supervisor = await this.#spawnSupervisor(directory, record.supervisorEnvironment);
      const processId = supervisor.pid;
      if (processId === undefined) {
        throw new Error("the supervisor started without a process identifier");
      }
      stopSupervisorsWhenThisProcessExits(supervisor);
      this.#launchedSupervisors.set(processId, supervisor);
      supervisor.once("exit", (exitCode, signal) => {
        this.#launchedSupervisors.delete(processId);
        this.#exitDescriptions.set(
          sandboxId,
          `its supervisor exited by itself (${signal ?? `exit code ${exitCode}`})`,
        );
      });
      await writeSupervisorProcessId(directory, processId);
    } finally {
      this.#launchingSandboxIds.delete(sandboxId);
    }
  }

  async #spawnSupervisor(
    sandboxDirectory: string,
    supervisorEnvironment: Readonly<Record<string, string>>,
  ): Promise<ChildProcess> {
    const [executable, ...commandArguments] = this.#settings.supervisorCommand;
    const supervisor = spawn(executable, commandArguments, {
      cwd: workspaceDirectoryIn(sandboxDirectory),
      env: this.#supervisorProcessEnvironment(sandboxDirectory, supervisorEnvironment),
      // The supervisor's JSON log lines join the control plane's own output.
      stdio: ["ignore", "inherit", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      supervisor.once("spawn", resolve);
      supervisor.once("error", reject);
    });
    return supervisor;
  }

  /**
   * The supervisor is marked as being stopped before it is signalled, so a
   * supervisor found gone while still marked running exited by itself, and
   * a stop cut short is finished by the next. Waits until it has exited,
   * killing it after the grace period.
   */
  async #stopSupervisor(sandboxId: string): Promise<void> {
    const directory = this.#directoryOf(sandboxId);
    const supervisor = await readSupervisorProcess(directory);
    this.#exitDescriptions.delete(sandboxId);
    if (supervisor === undefined) {
      return;
    }
    await markSupervisorBeingStopped(directory);
    const { processId } = supervisor;
    if (this.#isSupervisorRunning(processId)) {
      signalUnlessGone(processId, "SIGTERM");
      const killTimer = setTimeout(
        () => signalUnlessGone(processId, "SIGKILL"),
        this.#settings.stopTimeoutInMilliseconds,
      );
      while (this.#isSupervisorRunning(processId)) {
        await sleep(exitPollIntervalInMilliseconds);
      }
      clearTimeout(killTimer);
    }
    await removeSupervisorProcessId(directory);
  }

  /**
   * A supervisor this process launched is asked through its handle, since an
   * exited child can linger as a zombie for a moment; any other (one an
   * earlier control plane launched) through the operating system.
   */
  #isSupervisorRunning(processId: number): boolean {
    const launched = this.#launchedSupervisors.get(processId);
    if (launched !== undefined) {
      return !hasExited(launched);
    }
    return isProcessAlive(processId);
  }

  /**
   * The request's environment is applied last, so it can override the
   * directories, as a container's environment overrides its image's.
   */
  #supervisorProcessEnvironment(
    sandboxDirectory: string,
    supervisorEnvironment: Readonly<Record<string, string>>,
  ): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of hostVariableNames) {
      const value = this.#hostEnvironment[name];
      if (value !== undefined) {
        environment[name] = value;
      }
    }
    return {
      ...environment,
      BARRACK_WORKSPACE_DIRECTORY: workspaceDirectoryIn(sandboxDirectory),
      BARRACK_STATE_DIRECTORY: stateDirectoryIn(sandboxDirectory),
      BARRACK_SUPERVISOR_STATE_DIRECTORY: supervisorStateDirectoryIn(sandboxDirectory),
      ...supervisorEnvironment,
    };
  }

  async #requireRecord(attemptedOperation: string, sandboxId: string): Promise<LocalSandboxRecord> {
    const record = isLocalSandboxId(sandboxId)
      ? await readSandboxRecord(this.#directoryOf(sandboxId))
      : undefined;
    if (record === undefined) {
      throw new SandboxNotFoundError(attemptedOperation, sandboxId);
    }
    return record;
  }

  /** Only for identifiers `isLocalSandboxId` accepts, which cannot leave the sandboxes directory. */
  #directoryOf(sandboxId: string): string {
    return path.join(this.#settings.sandboxesDirectory, sandboxId);
  }
}

function workspaceDirectoryIn(sandboxDirectory: string): string {
  return path.join(sandboxDirectory, "workspace");
}

function stateDirectoryIn(sandboxDirectory: string): string {
  return path.join(sandboxDirectory, "state");
}

/** What the supervisor keeps for itself across its own restarts; see the supervisor's README. */
function supervisorStateDirectoryIn(sandboxDirectory: string): string {
  return path.join(sandboxDirectory, "supervisor");
}

/**
 * The workspace is made a Git repository of its own. On a real provider it
 * is a directory on a fresh computer, inside no repository; here it may well
 * be inside a checkout (under `pnpm dev`, Barrack's own), and without a
 * repository of its own the agent's Git commands would act on that checkout.
 */
async function prepareDirectories(sandboxDirectory: string): Promise<void> {
  const workspaceDirectory = workspaceDirectoryIn(sandboxDirectory);
  await mkdir(workspaceDirectory, { recursive: true });
  await mkdir(stateDirectoryIn(sandboxDirectory), { recursive: true });
  await mkdir(supervisorStateDirectoryIn(sandboxDirectory), { recursive: true });
  await promisify(execFile)("git", ["init", "--quiet"], { cwd: workspaceDirectory });
}

function hasExited(childProcess: ChildProcess): boolean {
  return childProcess.exitCode !== null || childProcess.signalCode !== null;
}

function signalUnlessGone(processId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(processId, signal);
  } catch {
    // It exited between the check and the signal, which is what was wanted.
  }
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
