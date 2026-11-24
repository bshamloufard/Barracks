import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
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
 * disk, and starting launches the supervisor again in it. The provider's
 * record of its sandboxes lives in this process's memory, though, so when
 * the control plane exits it ends every supervisor it started, and after a
 * restart it reports every earlier sandbox as missing, leaving their
 * directories behind until someone deletes them.
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

type LocalSandbox = {
  sandboxId: string;
  threadId: string;
  directory: string;
  supervisorEnvironment: Readonly<Record<string, string>>;
  status: SandboxStatus;
  supervisor: ChildProcess | undefined;
};

export class LocalProcessSandboxProvider implements SandboxProvider {
  readonly #settings: LocalProcessProviderSettings;
  readonly #hostEnvironment: NodeJS.ProcessEnv;
  readonly #sandboxes = new Map<string, LocalSandbox>();

  constructor(settings: LocalProcessProviderSettings, hostEnvironment = process.env) {
    this.#settings = settings;
    this.#hostEnvironment = hostEnvironment;
  }

  async create(request: SandboxCreationRequest): Promise<CreatedSandbox> {
    validateCreationRequest(request);
    const attemptedOperation = describeSandboxCreation(request.threadId);
    const existing = [...this.#sandboxes.values()].find(
      (sandbox) => sandbox.threadId === request.threadId,
    );
    if (existing !== undefined) {
      throw new SandboxAlreadyExistsError(request.threadId, existing.sandboxId);
    }
    const sandboxId = `local-${randomUUID()}`;
    const sandbox: LocalSandbox = {
      sandboxId,
      threadId: request.threadId,
      directory: path.join(this.#settings.sandboxesDirectory, sandboxId),
      supervisorEnvironment: { ...request.supervisorEnvironment },
      status: { state: "starting" },
      supervisor: undefined,
    };
    this.#sandboxes.set(sandboxId, sandbox);
    try {
      await prepareDirectories(sandbox.directory);
      await this.#launchSupervisor(sandbox);
    } catch (error) {
      this.#sandboxes.delete(sandboxId);
      await rm(sandbox.directory, { recursive: true, force: true });
      throw new SandboxRefusedError(attemptedOperation, describeFailure(error));
    }
    return { sandboxId };
  }

  async start(sandboxId: string): Promise<void> {
    const attemptedOperation = `start sandbox "${sandboxId}"`;
    const sandbox = this.#require(attemptedOperation, sandboxId);
    if (sandbox.supervisor !== undefined) {
      return;
    }
    try {
      await this.#launchSupervisor(sandbox);
    } catch (error) {
      throw new SandboxRefusedError(attemptedOperation, describeFailure(error));
    }
  }

  async stop(sandboxId: string): Promise<void> {
    const sandbox = this.#require(`stop sandbox "${sandboxId}"`, sandboxId);
    await this.#stopSupervisor(sandbox);
  }

  async destroy(sandboxId: string): Promise<void> {
    const sandbox = this.#sandboxes.get(sandboxId);
    if (sandbox === undefined) {
      return;
    }
    await this.#stopSupervisor(sandbox);
    this.#sandboxes.delete(sandboxId);
    await rm(sandbox.directory, { recursive: true, force: true });
  }

  async getStatus(sandboxId: string): Promise<SandboxStatus> {
    return this.#sandboxes.get(sandboxId)?.status ?? { state: "missing" };
  }

  /**
   * A service inside a local sandbox listens on the host itself, so its
   * address is the port on the loopback interface. Nothing keeps two
   * sandboxes from wanting the same port.
   */
  async getServiceAddress(request: ServiceAddressRequest): Promise<ServiceAddress> {
    validateServiceAddressRequest(request);
    const attemptedOperation = describeServiceAddressLookup(request);
    const sandbox = this.#require(attemptedOperation, request.sandboxId);
    if (sandbox.status.state !== "running") {
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
    const sandbox = this.#sandboxes.get(sandboxId);
    return sandbox === undefined ? undefined : workspaceDirectoryIn(sandbox.directory);
  }

  /**
   * Resolves once the supervisor process has started, or rejects if it could
   * not be (its executable does not exist, say). From then on, a supervisor
   * that exits by itself leaves the sandbox `failed`, as a crashed computer
   * would; one ended by `stop` leaves it `stopped`.
   */
  async #launchSupervisor(sandbox: LocalSandbox): Promise<void> {
    sandbox.status = { state: "starting" };
    const [executable, ...commandArguments] = this.#settings.supervisorCommand;
    const supervisor = spawn(executable, commandArguments, {
      cwd: workspaceDirectoryIn(sandbox.directory),
      env: this.#supervisorProcessEnvironment(sandbox),
      // The supervisor's JSON log lines join the control plane's own output.
      stdio: ["ignore", "inherit", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      supervisor.once("spawn", resolve);
      supervisor.once("error", reject);
    });
    stopSupervisorsWhenThisProcessExits(supervisor);
    sandbox.supervisor = supervisor;
    sandbox.status = { state: "running" };
    supervisor.once("exit", (exitCode, signal) => {
      if (sandbox.supervisor !== supervisor) {
        return;
      }
      sandbox.supervisor = undefined;
      sandbox.status = {
        state: "failed",
        reason: `its supervisor exited by itself (${signal ?? `exit code ${exitCode}`})`,
      };
    });
  }

  async #stopSupervisor(sandbox: LocalSandbox): Promise<void> {
    const supervisor = sandbox.supervisor;
    sandbox.supervisor = undefined;
    sandbox.status = { state: "stopped" };
    if (supervisor === undefined || hasExited(supervisor)) {
      return;
    }
    const exited = new Promise<void>((resolve) => supervisor.once("exit", () => resolve()));
    supervisor.kill("SIGTERM");
    const killTimer = setTimeout(
      () => supervisor.kill("SIGKILL"),
      this.#settings.stopTimeoutInMilliseconds,
    );
    await exited;
    clearTimeout(killTimer);
  }

  /**
   * The request's environment is applied last, so it can override the
   * directories, as a container's environment overrides its image's.
   */
  #supervisorProcessEnvironment(sandbox: LocalSandbox): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of hostVariableNames) {
      const value = this.#hostEnvironment[name];
      if (value !== undefined) {
        environment[name] = value;
      }
    }
    return {
      ...environment,
      BARRACK_WORKSPACE_DIRECTORY: workspaceDirectoryIn(sandbox.directory),
      BARRACK_STATE_DIRECTORY: stateDirectoryIn(sandbox.directory),
      BARRACK_SUPERVISOR_STATE_DIRECTORY: supervisorStateDirectoryIn(sandbox.directory),
      // There is no second user here: the agent runs as the developer, like
      // the supervisor, and can read its token. Using this provider at all
      // already required declaring development use.
      BARRACK_AGENT_SHARES_SUPERVISOR_USER: "development-only",
      ...sandbox.supervisorEnvironment,
    };
  }

  #require(attemptedOperation: string, sandboxId: string): LocalSandbox {
    const sandbox = this.#sandboxes.get(sandboxId);
    if (sandbox === undefined) {
      throw new SandboxNotFoundError(attemptedOperation, sandboxId);
    }
    return sandbox;
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

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
