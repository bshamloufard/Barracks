/**
 * Keeps Pi in step with the thread's model access: what Pi's credential
 * files hold, and which model the running Pi was started on. A replaced
 * credential is written at once; a switch to another model, or a stop for
 * want of a key, waits for the run in progress to end, which keeps its own
 * provider's credential until then (`planPiCredentials`).
 */

import type { ModelAccess } from "../agent-harness.js";
import type { AgentProcessLauncher } from "../agent-process/agent-process-launcher.js";
import type { Logger } from "../logger.js";
import { isModelAccessUsable } from "../missing-model-access.js";
import { PiCredentialFile } from "./pi-credential-file.js";
import { isPiOutOfStep, type PiCredentials, planPiCredentials } from "./pi-credential-plan.js";
import { getPiDirectories, preparePiDirectories } from "./pi-installation.js";
import type { PiRunReporter } from "./pi-run-reporter.js";
import type { RestartablePiProcess } from "./restartable-pi-process.js";

export type PiModelAccessSyncSettings = {
  stateDirectory: string;
  agentProcessLauncher: AgentProcessLauncher;
  logger: Logger;
};

export class PiModelAccessSync {
  readonly #settings: PiModelAccessSyncSettings;
  readonly #logger: Logger;
  readonly #pi: RestartablePiProcess;
  readonly #runReporter: PiRunReporter;
  readonly #credentialFile: PiCredentialFile;
  /** What the control plane last said; undefined until it has. */
  #latest: ModelAccess | undefined;
  /** What the credential files hold, so unchanged credentials are not written again. */
  #credentialsOnFile: string | undefined;

  constructor(
    settings: PiModelAccessSyncSettings,
    pi: RestartablePiProcess,
    runReporter: PiRunReporter,
  ) {
    this.#settings = settings;
    this.#logger = settings.logger;
    this.#pi = pi;
    this.#runReporter = runReporter;
    const { agentDirectory } = getPiDirectories(settings.stateDirectory);
    this.#credentialFile = new PiCredentialFile(settings.agentProcessLauncher, agentDirectory);
  }

  /** What the control plane last said; undefined until it has. */
  get latest(): ModelAccess | undefined {
    return this.#latest;
  }

  /** Takes the control plane's latest word; `apply` acts on it. */
  update(access: ModelAccess): void {
    this.#latest = access;
  }

  /**
   * Brings the credential files and Pi in line with the latest model access.
   * The files change at once, keeping what the run in progress started with
   * (`planPiCredentials`); Pi is started, restarted on another model, or
   * stopped for want of a key only between runs, and this runs again when
   * the run in progress ends.
   */
  async apply(): Promise<void> {
    const access = this.#latest;
    if (access === undefined) {
      return;
    }
    const credentials = planPiCredentials(
      access,
      this.#pi.runningOn,
      this.#runReporter.isRunInProgress,
    );
    try {
      await this.#replaceCredentialFile(credentials);
    } catch (error) {
      this.#runReporter.reportAgentFailure(
        `The agent's key could not be handed to it: ${describeError(error)}`,
      );
      return;
    }
    this.#pi.noteCredentials(credentials);
    // Read again: the run may have ended while the files were written.
    if (this.#runReporter.isRunInProgress) {
      return;
    }
    if (!isModelAccessUsable(access)) {
      await this.#pi.stopUntilUsable("it has no key for its model");
      return;
    }
    await this.#pi.ensureRunningOn(access);
  }

  /** Whether Pi, or its credential files, are not what the latest model access asks for between runs. */
  isOutOfStep(): boolean {
    const betweenRuns = planPiCredentials(this.#latest, undefined, false);
    return (
      isPiOutOfStep(this.#latest, this.#pi.runningOn) ||
      describeCredentials(betweenRuns) !== this.#credentialsOnFile
    );
  }

  /** On starting and stopping: a failure is logged, and stops nothing else. */
  async eraseCredentialFile(occasion: string): Promise<void> {
    try {
      await this.#replaceCredentialFile(new Map());
    } catch (error) {
      this.#logger.error({ err: error, occasion }, "Could not erase the agent's credential file");
    }
  }

  async #replaceCredentialFile(credentials: PiCredentials): Promise<void> {
    const contents = describeCredentials(credentials);
    if (contents === this.#credentialsOnFile) {
      return;
    }
    await preparePiDirectories(this.#settings.stateDirectory);
    if (credentials.size === 0) {
      await this.#credentialFile.erase();
    } else {
      await this.#credentialFile.write(credentials);
    }
    this.#credentialsOnFile = contents;
    this.#logger.info(
      { providers: [...credentials.keys()] },
      credentials.size === 0 ? "Erased the agent's credential" : "Wrote the agent's credentials",
    );
  }
}

/** The same credentials always describe the same, whatever order they were planned in. */
function describeCredentials(credentials: PiCredentials): string {
  return JSON.stringify([...credentials].sort(([first], [second]) => first.localeCompare(second)));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
