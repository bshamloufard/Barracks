import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentEvent, maximumErrorMessageLength } from "@barrack/protocol";
import type { AgentHarness, AgentHarnessObserver, UserMessage } from "../agent-harness.js";
import type { Logger } from "../logger.js";
import { buildPiEnvironment } from "./pi-environment.js";
import {
  initialTranslationState,
  releaseHeldErroredMessage,
  type Translation,
  type TranslationState,
  translatePiEvent,
} from "./pi-event-translator.js";
import { type PiExit, PiProcess } from "./pi-process.js";
import { type PiEvent, type PiExtensionUiRequest, parsePiState } from "./pi-records.js";
import { PiCommandRejectedError, PiOutputEndedError } from "./pi-rpc-client.js";

export type PiAgentHarnessSettings = {
  threadId: string;
  /** In Pi's `provider/model` form. */
  model: string;
  workspaceDirectory: string;
  /** Pi's sessions and its agent directory (credentials, settings, custom models) live under here. */
  stateDirectory: string;
  /** The supervisor's environment, from which Pi's is built. */
  sourceEnvironment: NodeJS.ProcessEnv;
  logger: Logger;
  mintIdentifier?: () => string;
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

export function getPiDirectories(stateDirectory: string) {
  return {
    agentDirectory: path.join(stateDirectory, "pi", "agent"),
    sessionDirectory: path.join(stateDirectory, "pi", "sessions"),
  };
}

/**
 * Runs the Pi coding agent as a child process in its RPC mode. Pi is started
 * eagerly, started again on the next user message if it exits unexpectedly,
 * and given the same session each time so the conversation carries on.
 */
export class PiAgentHarness implements AgentHarness {
  readonly #observer: AgentHarnessObserver;
  readonly #settings: PiAgentHarnessSettings;
  readonly #logger: Logger;
  readonly #mintIdentifier: () => string;
  readonly #pendingUserMessages: UserMessage[] = [];
  #piProcess: PiProcess | undefined;
  #launching: Promise<PiProcess | undefined> | undefined;
  #delivering: Promise<void> | undefined;
  #translationState: TranslationState = initialTranslationState;
  #sessionFile: string | undefined;
  #isStopped = false;

  constructor(observer: AgentHarnessObserver, settings: PiAgentHarnessSettings) {
    this.#observer = observer;
    this.#settings = settings;
    this.#logger = settings.logger;
    this.#mintIdentifier = settings.mintIdentifier ?? randomUUID;
  }

  async start(): Promise<void> {
    await this.#ensureRunning();
  }

  deliverUserMessage(message: UserMessage): void {
    if (this.#isStopped) {
      this.#logger.warn({ messageId: message.messageId }, "Ignoring a user message after stopping");
      return;
    }
    this.#pendingUserMessages.push(message);
    this.#delivering ??= this.#deliverPendingMessages()
      .catch((error: unknown) => {
        this.#logger.error({ err: error }, "Delivering user messages to Pi failed");
      })
      .finally(() => {
        this.#delivering = undefined;
      });
  }

  /**
   * Clears Pi's queue before aborting, because `abort` alone leaves queued
   * messages in place and Pi would answer them at the end of the next run.
   * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
   */
  async interrupt(): Promise<void> {
    this.#dropPendingUserMessages("the agent was interrupted");
    // A prompt already on its way must reach Pi's queue before it is cleared.
    await this.#delivering;
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

  async stop(): Promise<void> {
    this.#isStopped = true;
    this.#dropPendingUserMessages("the supervisor is stopping");
    await this.#launching;
    await this.#piProcess?.stop();
  }

  async #deliverPendingMessages(): Promise<void> {
    let message = this.#pendingUserMessages.shift();
    while (message !== undefined) {
      await this.#deliver(message);
      message = this.#pendingUserMessages.shift();
    }
  }

  /**
   * Always prompts with `steer`: an idle Pi starts a run, and a busy one takes
   * the message up after its current turn. Pi rejects a prompt to a busy
   * agent that does not say which. Waiting for each answer before the next
   * prompt keeps two prompts from racing to start a run.
   */
  async #deliver(message: UserMessage): Promise<void> {
    const piProcess = await this.#ensureRunning();
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
      this.#reportRejectedMessage(error.reason);
      return;
    }
    // Pi exited while the prompt was in flight; its exit is reported as `agent_failed`.
    this.#logger.warn(
      { messageId: message.messageId, err: error },
      "A user message did not reach Pi",
    );
  }

  /**
   * A message Pi refuses (no credentials for the model, say) would otherwise
   * leave the user waiting for a reply that never comes. It is shown the way
   * a model provider error is: an assistant message that ended in an error,
   * inside a run of its own when the agent was idle.
   */
  #reportRejectedMessage(reason: string): void {
    const isIdle = !this.#translationState.isRunActive;
    if (isIdle) {
      this.#emitEvent({ type: "agent_run_started" });
    }
    this.#emitEvent({
      type: "assistant_message",
      messageId: this.#mintIdentifier(),
      content: [],
      endReason: "errored",
      errorMessage: limitErrorMessage(`Pi did not accept the message: ${reason}`),
    });
    if (isIdle) {
      this.#emitEvent({ type: "agent_run_settled", wasInterrupted: false });
    }
  }

  #ensureRunning(): Promise<PiProcess | undefined> {
    if (this.#piProcess !== undefined && !this.#piProcess.hasExited) {
      return Promise.resolve(this.#piProcess);
    }
    this.#launching ??= this.#launch().finally(() => {
      this.#launching = undefined;
    });
    return this.#launching;
  }

  async #launch(): Promise<PiProcess | undefined> {
    if (this.#isStopped) {
      return undefined;
    }
    let piProcess: PiProcess;
    try {
      piProcess = await this.#spawnPi();
    } catch (error) {
      this.#reportAgentFailure(`Pi could not be started: ${describeError(error)}`);
      return undefined;
    }
    this.#piProcess = piProcess;
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

  async #spawnPi(): Promise<PiProcess> {
    const { agentDirectory, sessionDirectory } = getPiDirectories(this.#settings.stateDirectory);
    await mkdir(agentDirectory, { recursive: true });
    await mkdir(sessionDirectory, { recursive: true });
    // Pi creates the session file with the first message, so a Pi that
    // exited before any message has no file to reopen yet.
    const sessionFileToResume =
      this.#sessionFile !== undefined && existsSync(this.#sessionFile)
        ? this.#sessionFile
        : undefined;
    this.#logger.info({ sessionFile: sessionFileToResume ?? null }, "Starting Pi");
    return new PiProcess(
      {
        entryPointPath: resolvePiEntryPointPath(),
        workspaceDirectory: this.#settings.workspaceDirectory,
        sessionDirectory,
        sessionId: this.#settings.threadId,
        sessionFileToResume,
        model: this.#settings.model,
        environment: buildPiEnvironment(this.#settings.sourceEnvironment, agentDirectory),
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
      } else {
        this.#observer.onStreamFragment(message.fragment);
      }
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
    this.#applyTranslation(releaseHeldErroredMessage(this.#translationState));
    this.#translationState = initialTranslationState;
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

  #dropPendingUserMessages(reason: string): void {
    const droppedMessages = this.#pendingUserMessages.splice(0);
    for (const message of droppedMessages) {
      this.#logger.info({ messageId: message.messageId, reason }, "Dropped a user message");
    }
  }

  #emitEvent(event: AgentEvent): void {
    this.#observer.onAgentEvent(event);
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

function limitErrorMessage(errorMessage: string): string {
  return errorMessage.slice(0, maximumErrorMessageLength);
}
