/**
 * The thread's one Pi process: starting it and waiting until it is ready,
 * starting it again on another model, and stopping it. Every Pi it starts
 * resumes the same session, so the conversation carries on whichever Pi
 * answers. When to start or stop Pi is decided by the harness; this only
 * knows how.
 */

import { existsSync } from "node:fs";
import { parseModelReference } from "@barrack/protocol";
import type { AgentProcessLauncher } from "../agent-process/agent-process-launcher.js";
import type { DesktopConfiguration } from "../configuration.js";
import type { Logger } from "../logger.js";
import type { UsableModelAccess } from "../missing-model-access.js";
import {
  isPiOutOfStep,
  isUsableWithoutRestart,
  type PiCredentials,
  type PiRunningOn,
} from "./pi-credential-plan.js";
import { buildPiEnvironment } from "./pi-environment.js";
import {
  getPiDirectories,
  preparePiDirectories,
  resolveComputerUseExtensionPath,
  resolvePiEntryPointPath,
} from "./pi-installation.js";
import { type PiExit, PiProcess } from "./pi-process.js";
import { type PiEvent, type PiExtensionUiRequest, parsePiState } from "./pi-records.js";
import { PiOutputEndedError } from "./pi-rpc-client.js";
import type { PiStopTiming } from "./pi-stop-timing.js";
import { removeStoredModelCatalogue } from "./stored-model-catalogue.js";

export type RestartablePiProcessSettings = {
  threadId: string;
  workspaceDirectory: string;
  stateDirectory: string;
  sourceEnvironment: NodeJS.ProcessEnv;
  agentProcessLauncher: AgentProcessLauncher;
  desktop?: DesktopConfiguration | undefined;
  logger: Logger;
  stopTiming: PiStopTiming;
};

export type RestartablePiProcessHandlers = {
  onEvent: (event: PiEvent) => void;
  onExit: (exit: PiExit) => void;
  /** Pi could not be started, or did not become ready. */
  onStartFailed: (description: string) => void;
};

/**
 * Pi writes nothing until it receives a command, so readiness is the answer
 * to a `get_state` request. It normally arrives within a second; the limit
 * only catches a Pi that hangs while starting.
 */
const readinessTimeoutInMilliseconds = 60_000;

/** Extension UI methods that block Pi until the client answers. */
const dialogMethods = ["select", "confirm", "input", "editor"];

export class RestartablePiProcess {
  readonly #settings: RestartablePiProcessSettings;
  readonly #handlers: RestartablePiProcessHandlers;
  readonly #logger: Logger;
  #piProcess: PiProcess | undefined;
  /** The model the latest Pi was started on, and its provider's credential now. */
  #runningOn: PiRunningOn | undefined;
  #sessionFile: string | undefined;
  #isRetired = false;

  constructor(settings: RestartablePiProcessSettings, handlers: RestartablePiProcessHandlers) {
    this.#settings = settings;
    this.#handlers = handlers;
    this.#logger = settings.logger;
  }

  /** Pi while it runs; undefined before it starts and once it has exited. */
  get current(): PiProcess | undefined {
    return this.#piProcess !== undefined && !this.#piProcess.hasExited
      ? this.#piProcess
      : undefined;
  }

  /** What the running Pi was started on, or undefined when no Pi is running. */
  get runningOn(): PiRunningOn | undefined {
    return this.current === undefined ? undefined : this.#runningOn;
  }

  /**
   * A credential replaced in place for the running Pi's provider is the one
   * it uses now. One it cannot use without starting again (another address,
   * or a ChatGPT plan in place of a key) is not, so that `ensureRunningOn`
   * still finds Pi out of step and starts it again.
   */
  noteCredentials(credentials: PiCredentials): void {
    const runningOn = this.#runningOn;
    if (runningOn === undefined) {
      return;
    }
    const replacement = credentials.get(parseModelReference(runningOn.model).providerId);
    if (replacement !== undefined && isUsableWithoutRestart(runningOn.credential, replacement)) {
      this.#runningOn = { ...runningOn, credential: replacement };
    }
  }

  /** Pi as it runs, whatever its model: a message never waits for a model switch. */
  async ensureRunning(access: UsableModelAccess): Promise<PiProcess | undefined> {
    return this.current ?? this.#launch(access);
  }

  /** Pi on exactly this model access, started again if it runs on another. Only between runs. */
  async ensureRunningOn(access: UsableModelAccess): Promise<PiProcess | undefined> {
    const piProcess = this.current;
    if (piProcess !== undefined) {
      if (!isPiOutOfStep(access, this.#runningOn)) {
        return piProcess;
      }
      this.#logger.info(
        { fromModel: this.#runningOn?.model, toModel: access.model },
        "Starting Pi again on another model or provider address",
      );
      await piProcess.stop();
    }
    return this.#launch(access);
  }

  /** Stops a running Pi, which is started again when it can run. */
  async stopUntilUsable(reason: string): Promise<void> {
    const piProcess = this.current;
    if (piProcess === undefined) {
      return;
    }
    this.#logger.info({ reason }, "Stopping Pi until it can run again");
    await piProcess.stop();
  }

  /** No Pi is started after this: the supervisor is stopping. */
  retire(): void {
    this.#isRetired = true;
  }

  async stop(): Promise<void> {
    await this.#piProcess?.stop();
  }

  /** Only ever called from the harness's command queue, so two launches cannot overlap. */
  async #launch(access: UsableModelAccess): Promise<PiProcess | undefined> {
    if (this.#isRetired) {
      return undefined;
    }
    let piProcess: PiProcess;
    try {
      piProcess = await this.#spawnPi(access.model);
    } catch (error) {
      this.#handlers.onStartFailed(`Pi could not be started: ${describeError(error)}`);
      return undefined;
    }
    this.#piProcess = piProcess;
    this.#runningOn = { model: access.model, credential: access.credential };
    return this.#waitUntilReady(piProcess);
  }

  async #waitUntilReady(piProcess: PiProcess): Promise<PiProcess | undefined> {
    try {
      const stateData = await rejectAfter(
        piProcess.client.send({ type: "get_state" }),
        readinessTimeoutInMilliseconds,
        `Pi did not answer get_state within ${readinessTimeoutInMilliseconds} ms.`,
      );
      this.#rememberSessionFile(stateData);
      return piProcess;
    } catch (error) {
      // If Pi exited, its exit has already been reported as `agent_failed`.
      if (!(error instanceof PiOutputEndedError)) {
        this.#handlers.onStartFailed(`Pi did not become ready: ${describeError(error)}`);
        await piProcess.stop();
      }
      return undefined;
    }
  }

  async #spawnPi(model: string): Promise<PiProcess> {
    const settings = this.#settings;
    await preparePiDirectories(settings.stateDirectory);
    const { agentDirectory, sessionDirectory } = getPiDirectories(settings.stateDirectory);
    await removeStoredModelCatalogue(settings.agentProcessLauncher, agentDirectory);
    // Pi creates the session file with the first message, so a Pi that
    // exited before any message has no file to reopen yet.
    const sessionFileToResume =
      this.#sessionFile !== undefined && existsSync(this.#sessionFile)
        ? this.#sessionFile
        : undefined;
    const { desktop } = settings;
    this.#logger.info(
      {
        model,
        sessionFile: sessionFileToResume ?? null,
        runsAs: settings.agentProcessLauncher.description,
        hasComputerTool: desktop !== undefined,
      },
      "Starting Pi",
    );
    const piProcess: PiProcess = new PiProcess(
      {
        entryPointPath: resolvePiEntryPointPath(),
        workspaceDirectory: settings.workspaceDirectory,
        sessionDirectory,
        sessionId: settings.threadId,
        sessionFileToResume,
        model,
        extensionPaths: desktop === undefined ? [] : [resolveComputerUseExtensionPath()],
        environment: buildPiEnvironment(settings.sourceEnvironment, agentDirectory, desktop),
        launcher: settings.agentProcessLauncher,
        stopTiming: settings.stopTiming,
      },
      {
        onEvent: this.#handlers.onEvent,
        onExtensionUiRequest: (request) => this.#answerExtensionUiRequest(piProcess, request),
        onExit: this.#handlers.onExit,
      },
      this.#logger,
    );
    return piProcess;
  }

  #rememberSessionFile(stateData: unknown): void {
    const state = parsePiState(stateData);
    if (!state.ok) {
      this.#logger.warn({ reason: state.errorMessage }, "Pi's state has an unexpected shape");
      return;
    }
    this.#sessionFile = state.value.sessionFile ?? this.#sessionFile;
    this.#logger.info({ sessionFile: this.#sessionFile ?? null }, "Pi is ready");
  }

  /**
   * Nobody can answer an extension's question in Milestone 1, and an
   * unanswered dialog blocks Pi, so dialogs are cancelled at once.
   */
  #answerExtensionUiRequest(piProcess: PiProcess, request: PiExtensionUiRequest): void {
    if (!dialogMethods.includes(request.method)) {
      this.#logger.debug({ method: request.method }, "Ignoring an extension UI notification");
      return;
    }
    this.#logger.info({ method: request.method }, "Cancelling an extension dialog");
    piProcess.client.sendWithoutResponse({
      type: "extension_ui_response",
      id: request.id,
      cancelled: true,
    });
  }
}

function rejectAfter<Value>(
  promise: Promise<Value>,
  timeoutInMilliseconds: number,
  timeoutMessage: string,
): Promise<Value> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutInMilliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
