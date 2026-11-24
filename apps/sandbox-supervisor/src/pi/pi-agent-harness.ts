import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentEvent,
  type ModelAccessErrorKind,
  maximumErrorMessageLength,
  parseModelReference,
} from "@barrack/protocol";
import type {
  AgentHarness,
  AgentHarnessObserver,
  ModelAccess,
  UserMessage,
} from "../agent-harness.js";
import type { AgentProcessLauncher } from "../agent-process/agent-process-launcher.js";
import type { DesktopConfiguration } from "../configuration.js";
import { finishesWithin } from "../finishes-within.js";
import type { Logger } from "../logger.js";
import {
  describeMissingModelAccess,
  isModelAccessUsable,
  type UsableModelAccess,
} from "../missing-model-access.js";
import { classifyModelAccessError } from "./classify-model-access-error.js";
import { PiCredentialFile } from "./pi-credential-file.js";
import {
  isPiOutOfStep,
  type PiCredentials,
  type PiRunningOn,
  planPiCredentials,
} from "./pi-credential-plan.js";
import { buildPiEnvironment } from "./pi-environment.js";
import {
  initialTranslationState,
  type Translation,
  type TranslationState,
  translatePiEvent,
  translatePiExit,
} from "./pi-event-translator.js";
import { type PiExit, PiProcess } from "./pi-process.js";
import { type PiEvent, type PiExtensionUiRequest, parsePiState } from "./pi-records.js";
import { PiCommandRejectedError, PiOutputEndedError } from "./pi-rpc-client.js";
import { defaultPiStopTiming, type PiStopTiming } from "./pi-stop-timing.js";
import { SerialCommandQueue } from "./serial-command-queue.js";

export type PiAgentHarnessSettings = {
  threadId: string;
  workspaceDirectory: string;
  /** Pi's sessions and its agent directory (credentials, settings, custom models) live under here. */
  stateDirectory: string;
  /** The supervisor's environment, from which Pi's is built. */
  sourceEnvironment: NodeJS.ProcessEnv;
  /** Decides which operating-system user Pi runs as. */
  agentProcessLauncher: AgentProcessLauncher;
  /** The sandbox's desktop, which Pi's computer tool uses; undefined gives Pi no such tool. */
  desktop?: DesktopConfiguration | undefined;
  logger: Logger;
  mintIdentifier?: () => string;
  stopTiming?: Partial<PiStopTiming>;
};

/**
 * Pi writes nothing until it receives a command, so readiness is the answer
 * to a `get_state` request. It normally arrives within a second; the limit
 * only catches a Pi that hangs while starting.
 */
const readinessTimeoutInMilliseconds = 60_000;

/** Extension UI methods that block Pi until the client answers. */
const dialogMethods = ["select", "confirm", "input", "editor"];

export function resolvePiEntryPointPath(): string {
  // The package exports its RPC entry point under the `import` condition
  // only, so `require.resolve` cannot find it.
  return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
}

/**
 * The computer tool, as an extension Pi loads (`--extension`). Pi compiles
 * extensions itself, so this is the built file in the image and the source
 * file when the supervisor runs from its sources.
 */
export function resolveComputerUseExtensionPath(): string {
  const fileExtension = path.extname(fileURLToPath(import.meta.url));
  return fileURLToPath(
    new URL(`./computer-use/computer-use-extension${fileExtension}`, import.meta.url),
  );
}

export function getPiDirectories(stateDirectory: string) {
  return {
    agentDirectory: path.join(stateDirectory, "pi", "agent"),
    sessionDirectory: path.join(stateDirectory, "pi", "sessions"),
  };
}

/**
 * Runs the Pi coding agent as a child process in its RPC mode, on the model
 * and with the credential the control plane says, given the same session
 * each time so the conversation carries on.
 *
 * Pi runs only while it has a model and a credential for that model's
 * provider (the owner's key, or a token for the control plane's model
 * proxy): it is started once the first credential arrives, and again on
 * the next user message if it exits unexpectedly. The credential reaches Pi
 * through its own files (`PiCredentialFile`), never its environment. A
 * replaced one is written over the old, and Pi uses it from its next
 * request. A removed one is erased at once, and Pi stopped once its run
 * ends; it starts again when a credential comes back. Another model needs a
 * new Pi: the pinned Pi neither offers a provider that had no key when it
 * started nor rereads its model list, so `set_model` cannot reach one. So
 * the switch waits for the run in progress to end, which keeps its own
 * provider's credential until then (`planPiCredentials`), and Pi is
 * started again on the new model, resuming its session: the new model is
 * sent the conversation so far.
 *
 * Starting Pi, delivering a message, interrupting, stopping and applying
 * model access all take turns in one queue, so each finishes before the
 * next begins. Otherwise a message sent just after an interrupt could reach
 * Pi between `clear_queue` and `abort`; Pi would queue it as steering,
 * `abort` would leave it queued, and it would be answered out of order at
 * the end of some later run.
 */
export class PiAgentHarness implements AgentHarness {
  readonly #observer: AgentHarnessObserver;
  readonly #settings: PiAgentHarnessSettings;
  readonly #logger: Logger;
  readonly #mintIdentifier: () => string;
  readonly #stopTiming: PiStopTiming;
  readonly #commands = new SerialCommandQueue();
  readonly #credentialFile: PiCredentialFile;
  /** Messages waiting their turn in the queue; an interrupt drops them. */
  readonly #undeliveredUserMessages = new Set<UserMessage>();
  #piProcess: PiProcess | undefined;
  /** The model the running Pi was started on, and its provider's credential now. */
  #runningOn: PiRunningOn | undefined;
  #translationState: TranslationState = initialTranslationState;
  /** From a prompt Pi accepted until its run ends, so Pi is never restarted under a run. */
  #isRunInProgress = false;
  /** What the control plane last said; undefined until it has. */
  #modelAccess: ModelAccess | undefined;
  /** What the credential files hold, so unchanged credentials are not written again. */
  #credentialsOnFile: string | undefined;
  #sessionFile: string | undefined;
  #isStopped = false;

  constructor(observer: AgentHarnessObserver, settings: PiAgentHarnessSettings) {
    this.#observer = observer;
    this.#settings = settings;
    this.#logger = settings.logger;
    this.#mintIdentifier = settings.mintIdentifier ?? randomUUID;
    this.#stopTiming = { ...defaultPiStopTiming, ...settings.stopTiming };
    const { agentDirectory } = getPiDirectories(settings.stateDirectory);
    this.#credentialFile = new PiCredentialFile(settings.agentProcessLauncher, agentDirectory);
  }

  /**
   * Clears any credential an earlier supervisor left behind (one that was
   * killed, say), so nothing runs on a key the control plane has not just
   * sent. Pi itself starts once model access arrives.
   */
  async start(): Promise<void> {
    await this.#commands.run(() => this.#eraseCredentialFile("starting"));
  }

  configureModelAccess(access: ModelAccess): void {
    if (this.#isStopped) {
      return;
    }
    this.#modelAccess = access;
    this.#logger.info(
      { model: access.model, hasCredential: access.credential !== null },
      "Received the thread's model access",
    );
    this.#queueApplyingModelAccess();
  }

  deliverUserMessage(message: UserMessage): void {
    if (this.#isStopped) {
      this.#logger.warn({ messageId: message.messageId }, "Ignoring a user message after stopping");
      return;
    }
    this.#undeliveredUserMessages.add(message);
    this.#commands
      .run(() => this.#deliverUnlessDropped(message))
      .catch((error: unknown) => {
        this.#logger.error(
          { err: error, messageId: message.messageId },
          "Delivering a user message to Pi failed",
        );
      });
  }

  interrupt(): Promise<void> {
    this.#dropUndeliveredUserMessages("the agent was interrupted");
    return this.#commands.run(() => this.#interruptPi());
  }

  /**
   * Stops Pi in its turn, after the command it is working on, but does not
   * wait for that command for long: Pi answers `abort` only once the agent
   * is idle, and a Pi that never does would hold the sandbox's shutdown up
   * forever. After the wait, Pi is stopped regardless; its ending fails the
   * command in flight, and the stop in the queue then finds it gone. The
   * credential file is erased last, so a stopped sandbox keeps no key.
   */
  async stop(): Promise<void> {
    this.#isStopped = true;
    this.#dropUndeliveredUserMessages("the supervisor is stopping");
    const stoppedInTurn = this.#commands.run(async () => this.#piProcess?.stop());
    const waitInMilliseconds = this.#stopTiming.commandInFlightTimeoutInMilliseconds;
    if (!(await finishesWithin(stoppedInTurn, waitInMilliseconds))) {
      this.#logger.warn(
        { waitInMilliseconds },
        "Pi is still busy with a command; stopping it without waiting further",
      );
      await this.#piProcess?.stop();
      if (!(await finishesWithin(stoppedInTurn, waitInMilliseconds))) {
        this.#logger.error("The command Pi was busy with never finished; no longer waiting for it");
      }
    }
    await this.#eraseCredentialFile("stopping");
  }

  /** On starting and stopping: a failure is logged, and stops nothing else. */
  async #eraseCredentialFile(occasion: string): Promise<void> {
    try {
      await this.#replaceCredentialFile(new Map());
    } catch (error) {
      this.#logger.error({ err: error, occasion }, "Could not erase the agent's credential file");
    }
  }

  #queueApplyingModelAccess(): void {
    this.#commands
      .run(() => this.#applyModelAccess())
      .catch((error: unknown) => {
        this.#logger.error({ err: error }, "Applying the thread's model access failed");
      });
  }

  /**
   * Brings the credential files and Pi in line with the latest model access.
   * The files change at once, keeping what the run in progress started with
   * (`planPiCredentials`); Pi is started, restarted on another model, or
   * stopped for want of a key only between runs, and this runs again when
   * the run in progress ends.
   */
  async #applyModelAccess(): Promise<void> {
    const access = this.#modelAccess;
    if (access === undefined || this.#isStopped) {
      return;
    }
    const credentials = planPiCredentials(access, this.#aliveRunningOn(), this.#isRunInProgress);
    try {
      await this.#replaceCredentialFile(credentials);
    } catch (error) {
      this.#reportAgentFailure(
        `The agent's key could not be handed to it: ${describeError(error)}`,
      );
      return;
    }
    this.#noteRunningCredential(credentials);
    if (this.#isRunInProgress) {
      return;
    }
    if (!isModelAccessUsable(access)) {
      await this.#stopPiProcess("it has no key for its model");
      return;
    }
    await this.#ensureRunningOn(access);
  }

  /** What the running Pi was started on, or undefined when no Pi is running. */
  #aliveRunningOn(): PiRunningOn | undefined {
    return this.#piProcess !== undefined && !this.#piProcess.hasExited
      ? this.#runningOn
      : undefined;
  }

  /** A credential replaced in place for the running Pi's provider is the one it uses now. */
  #noteRunningCredential(credentials: PiCredentials): void {
    const runningOn = this.#runningOn;
    if (runningOn === undefined) {
      return;
    }
    const current = credentials.get(parseModelReference(runningOn.model).providerId);
    if (current !== undefined) {
      this.#runningOn = { ...runningOn, credential: current };
    }
  }

  /** Whether Pi, or its credential files, are not what the latest model access asks for between runs. */
  #isOutOfStepWithModelAccess(): boolean {
    const betweenRuns = planPiCredentials(this.#modelAccess, undefined, false);
    return (
      isPiOutOfStep(this.#modelAccess, this.#aliveRunningOn()) ||
      describeCredentials(betweenRuns) !== this.#credentialsOnFile
    );
  }

  async #replaceCredentialFile(credentials: PiCredentials): Promise<void> {
    const contents = describeCredentials(credentials);
    if (contents === this.#credentialsOnFile) {
      return;
    }
    await this.#prepareDirectories();
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

  /**
   * Clears Pi's queue before aborting, because `abort` alone leaves queued
   * messages in place and Pi would answer them at the end of the next run.
   * Pi answers `abort` only once the agent is idle.
   * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
   */
  async #interruptPi(): Promise<void> {
    const piProcess = this.#piProcess;
    if (piProcess === undefined || piProcess.hasExited) {
      this.#logger.info("Nothing to interrupt: Pi is not running");
      return;
    }
    try {
      await piProcess.client.send({ type: "clear_queue" });
      await piProcess.client.send({ type: "abort" });
      this.#logger.info("Interrupted Pi");
    } catch (error) {
      this.#logger.error({ err: error }, "Interrupting Pi failed");
    }
  }

  async #deliverUnlessDropped(message: UserMessage): Promise<void> {
    if (this.#undeliveredUserMessages.delete(message)) {
      await this.#deliver(message);
    }
  }

  /**
   * Always prompts with `steer`: an idle Pi starts a run, and a busy one takes
   * the message up after its current turn. Pi rejects a prompt to a busy
   * agent that does not say which. Waiting for each answer before the next
   * prompt keeps two prompts from racing to start a run.
   */
  async #deliver(message: UserMessage): Promise<void> {
    const access = this.#modelAccess;
    if (!isModelAccessUsable(access)) {
      this.#logger.warn(
        { messageId: message.messageId },
        "Answering a user message with no model access",
      );
      this.#reportUnansweredMessage(describeMissingModelAccess(access), "credential_missing");
      return;
    }
    const piProcess = await this.#ensureRunning(access);
    if (piProcess === undefined) {
      this.#logger.warn(
        { messageId: message.messageId },
        "Dropping a user message: Pi is not running",
      );
      return;
    }
    try {
      await piProcess.client.send({
        type: "prompt",
        message: message.text,
        streamingBehavior: "steer",
      });
      this.#isRunInProgress = true;
      this.#logger.info({ messageId: message.messageId }, "Delivered a user message to Pi");
    } catch (error) {
      this.#reportUndeliveredMessage(message, error);
    }
  }

  #reportUndeliveredMessage(message: UserMessage, error: unknown): void {
    if (error instanceof PiCommandRejectedError) {
      this.#logger.warn(
        { messageId: message.messageId, reason: error.reason },
        "Pi rejected a user message",
      );
      this.#reportUnansweredMessage(
        `Pi did not accept the message: ${error.reason}`,
        classifyModelAccessError(error.reason),
      );
      return;
    }
    // Pi exited while the prompt was in flight; its exit is reported as `agent_failed`.
    this.#logger.warn(
      { messageId: message.messageId, err: error },
      "A user message did not reach Pi",
    );
  }

  /**
   * A message the agent cannot take (Pi refused it, or there is no key)
   * would otherwise leave the user waiting for a reply that never comes. It
   * is shown the way a model provider error is: an assistant message that
   * ended in an error, inside a run of its own when the agent was idle.
   */
  #reportUnansweredMessage(
    errorMessage: string,
    errorKind: ModelAccessErrorKind | undefined,
  ): void {
    const isIdle = !this.#translationState.isRunActive;
    if (isIdle) {
      this.#emitEvent({ type: "agent_run_started" });
    }
    this.#emitEvent({
      type: "assistant_message",
      messageId: this.#mintIdentifier(),
      content: [],
      endReason: "errored",
      errorMessage: limitErrorMessage(errorMessage),
      ...(errorKind === undefined ? {} : { errorKind }),
    });
    if (isIdle) {
      this.#emitEvent({ type: "agent_run_settled", wasInterrupted: false });
    }
  }

  /** Pi as it runs, whatever its model: a message never waits for a model switch. */
  async #ensureRunning(access: UsableModelAccess): Promise<PiProcess | undefined> {
    if (this.#piProcess !== undefined && !this.#piProcess.hasExited) {
      return this.#piProcess;
    }
    return this.#launch(access);
  }

  /** Only ever runs in the command queue, between runs. */
  async #ensureRunningOn(access: UsableModelAccess): Promise<PiProcess | undefined> {
    const piProcess = this.#piProcess;
    if (piProcess !== undefined && !piProcess.hasExited) {
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

  async #stopPiProcess(reason: string): Promise<void> {
    const piProcess = this.#piProcess;
    if (piProcess === undefined || piProcess.hasExited) {
      return;
    }
    this.#logger.info({ reason }, "Stopping Pi until it can run again");
    await piProcess.stop();
  }

  /** Only ever runs in the command queue, so two launches cannot overlap. */
  async #launch(access: UsableModelAccess): Promise<PiProcess | undefined> {
    if (this.#isStopped) {
      return undefined;
    }
    let piProcess: PiProcess;
    try {
      piProcess = await this.#spawnPi(access.model);
    } catch (error) {
      this.#reportAgentFailure(`Pi could not be started: ${describeError(error)}`);
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
        this.#reportAgentFailure(`Pi did not become ready: ${describeError(error)}`);
        await piProcess.stop();
      }
      return undefined;
    }
  }

  #reportAgentFailure(description: string): void {
    this.#logger.error({ description }, "The agent failed");
    this.#emitEvent({ type: "agent_failed", errorMessage: limitErrorMessage(description) });
  }

  async #prepareDirectories(): Promise<void> {
    const { agentDirectory, sessionDirectory } = getPiDirectories(this.#settings.stateDirectory);
    await mkdir(agentDirectory, { recursive: true });
    await mkdir(sessionDirectory, { recursive: true });
  }

  async #spawnPi(model: string): Promise<PiProcess> {
    await this.#prepareDirectories();
    const { agentDirectory, sessionDirectory } = getPiDirectories(this.#settings.stateDirectory);
    // Pi creates the session file with the first message, so a Pi that
    // exited before any message has no file to reopen yet.
    const sessionFileToResume =
      this.#sessionFile !== undefined && existsSync(this.#sessionFile)
        ? this.#sessionFile
        : undefined;
    const { desktop } = this.#settings;
    this.#logger.info(
      {
        model,
        sessionFile: sessionFileToResume ?? null,
        runsAs: this.#settings.agentProcessLauncher.description,
        hasComputerTool: desktop !== undefined,
      },
      "Starting Pi",
    );
    return new PiProcess(
      {
        entryPointPath: resolvePiEntryPointPath(),
        workspaceDirectory: this.#settings.workspaceDirectory,
        sessionDirectory,
        sessionId: this.#settings.threadId,
        sessionFileToResume,
        model,
        extensionPaths: desktop === undefined ? [] : [resolveComputerUseExtensionPath()],
        environment: buildPiEnvironment(this.#settings.sourceEnvironment, agentDirectory, desktop),
        launcher: this.#settings.agentProcessLauncher,
        stopTiming: this.#stopTiming,
      },
      {
        onEvent: (event) => this.#handlePiEvent(event),
        onExtensionUiRequest: (request) => this.#answerExtensionUiRequest(request),
        onExit: (exit) => this.#handlePiExit(exit),
      },
      this.#logger,
    );
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

  #handlePiEvent(event: PiEvent): void {
    this.#applyTranslation(translatePiEvent(this.#translationState, event, this.#mintIdentifier));
  }

  #applyTranslation(translation: Translation): void {
    this.#translationState = translation.state;
    for (const description of translation.unrecognized) {
      this.#logger.debug({ description }, "Ignoring something Pi sent that is not translated");
    }
    for (const errorMessage of translation.retriedErrorMessages) {
      this.#logger.info({ errorMessage }, "Pi is retrying after a model provider error");
    }
    for (const message of translation.messages) {
      if (message.type === "agent_event") {
        this.#emitEvent(message.event);
        this.#noteRunProgress(message.event);
      } else {
        this.#observer.onStreamFragment(message.fragment);
      }
    }
  }

  /** A run's end is where a model switch, or a stop for want of a key, can happen. */
  #noteRunProgress(event: AgentEvent): void {
    if (event.type === "agent_run_started") {
      this.#isRunInProgress = true;
      return;
    }
    if (event.type !== "agent_run_settled" && event.type !== "agent_failed") {
      return;
    }
    this.#isRunInProgress = false;
    if (!this.#isStopped && this.#isOutOfStepWithModelAccess()) {
      this.#queueApplyingModelAccess();
    }
  }

  /**
   * Nobody can answer an extension's question in Milestone 1, and an
   * unanswered dialog blocks Pi, so dialogs are cancelled at once.
   */
  #answerExtensionUiRequest(request: PiExtensionUiRequest): void {
    if (!dialogMethods.includes(request.method)) {
      this.#logger.debug({ method: request.method }, "Ignoring an extension UI notification");
      return;
    }
    this.#logger.info({ method: request.method }, "Cancelling an extension dialog");
    this.#piProcess?.client.sendWithoutResponse({
      type: "extension_ui_response",
      id: request.id,
      cancelled: true,
    });
  }

  #handlePiExit(exit: PiExit): void {
    this.#applyTranslation(translatePiExit(this.#translationState, exit.wasRequested));
    this.#isRunInProgress = false;
    if (exit.wasRequested) {
      this.#logger.info({ description: exit.description }, "Pi stopped");
      this.#observer.onAgentProcessEnded({ wasExpected: true, description: exit.description });
      return;
    }
    const diagnostics = exit.recentDiagnostics.trim();
    const restartNote = "It will be started again on the next message.";
    this.#reportAgentFailure(
      diagnostics.length === 0
        ? `${exit.description} ${restartNote}`
        : `${exit.description} ${restartNote} Its last diagnostics:\n${diagnostics}`,
    );
    this.#observer.onAgentProcessEnded({ wasExpected: false, description: exit.description });
  }

  #dropUndeliveredUserMessages(reason: string): void {
    for (const message of this.#undeliveredUserMessages) {
      this.#logger.info({ messageId: message.messageId, reason }, "Dropped a user message");
    }
    this.#undeliveredUserMessages.clear();
  }

  #emitEvent(event: AgentEvent): void {
    this.#observer.onAgentEvent(event);
  }
}

/** The same credentials always describe the same, whatever order they were planned in. */
function describeCredentials(credentials: PiCredentials): string {
  return JSON.stringify([...credentials].sort(([first], [second]) => first.localeCompare(second)));
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

function limitErrorMessage(errorMessage: string): string {
  return errorMessage.slice(0, maximumErrorMessageLength);
}
