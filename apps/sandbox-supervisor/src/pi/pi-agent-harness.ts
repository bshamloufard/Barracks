/**
 * The agent harness for Pi: what the supervisor calls to hand the agent its
 * model access and the user's messages, to interrupt it and to stop it, and
 * the one queue in which all of those take turns. The work is shared out:
 *
 * - `RestartablePiProcess` starts, restarts and stops the Pi process;
 * - `PiModelAccessSync` keeps Pi and its credential files on the thread's
 *   model access;
 * - `PiRunReporter` translates what Pi does into the harness's events and
 *   knows whether a run is in progress.
 */

import { randomUUID } from "node:crypto";
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
import { describeMissingModelAccess, isModelAccessUsable } from "../missing-model-access.js";
import { classifyModelAccessError } from "./classify-model-access-error.js";
import { PiModelAccessSync } from "./pi-model-access-sync.js";
import { PiCommandRejectedError } from "./pi-rpc-client.js";
import { PiRunReporter } from "./pi-run-reporter.js";
import { defaultPiStopTiming, type PiStopTiming } from "./pi-stop-timing.js";
import { RestartablePiProcess } from "./restartable-pi-process.js";
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
  readonly #logger: Logger;
  readonly #stopTiming: PiStopTiming;
  readonly #commands = new SerialCommandQueue();
  readonly #runReporter: PiRunReporter;
  readonly #pi: RestartablePiProcess;
  readonly #modelAccess: PiModelAccessSync;
  /** Messages waiting their turn in the queue; an interrupt drops them. */
  readonly #undeliveredUserMessages = new Set<UserMessage>();
  #isStopped = false;

  constructor(observer: AgentHarnessObserver, settings: PiAgentHarnessSettings) {
    this.#logger = settings.logger;
    this.#stopTiming = { ...defaultPiStopTiming, ...settings.stopTiming };
    this.#runReporter = new PiRunReporter({
      observer,
      logger: settings.logger,
      mintIdentifier: settings.mintIdentifier ?? randomUUID,
      onRunEnded: () => this.#catchUpWithModelAccess(),
    });
    this.#pi = new RestartablePiProcess(
      { ...settings, stopTiming: this.#stopTiming },
      {
        onEvent: (event) => this.#runReporter.reportPiEvent(event),
        onExit: (exit) => this.#runReporter.reportPiExit(exit),
        onStartFailed: (description) => this.#runReporter.reportAgentFailure(description),
      },
    );
    this.#modelAccess = new PiModelAccessSync(settings, this.#pi, this.#runReporter);
  }

  /**
   * Clears any credential an earlier supervisor left behind (one that was
   * killed, say), so nothing runs on a key the control plane has not just
   * sent. Pi itself starts once model access arrives.
   */
  async start(): Promise<void> {
    await this.#commands.run(() => this.#modelAccess.eraseCredentialFile("starting"));
  }

  configureModelAccess(access: ModelAccess): void {
    if (this.#isStopped) {
      return;
    }
    this.#modelAccess.update(access);
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
    this.#pi.retire();
    this.#dropUndeliveredUserMessages("the supervisor is stopping");
    const stoppedInTurn = this.#commands.run(() => this.#pi.stop());
    const waitInMilliseconds = this.#stopTiming.commandInFlightTimeoutInMilliseconds;
    if (!(await finishesWithin(stoppedInTurn, waitInMilliseconds))) {
      this.#logger.warn(
        { waitInMilliseconds },
        "Pi is still busy with a command; stopping it without waiting further",
      );
      await this.#pi.stop();
      if (!(await finishesWithin(stoppedInTurn, waitInMilliseconds))) {
        this.#logger.error("The command Pi was busy with never finished; no longer waiting for it");
      }
    }
    await this.#modelAccess.eraseCredentialFile("stopping");
  }

  #queueApplyingModelAccess(): void {
    this.#commands
      .run(() => (this.#isStopped ? Promise.resolve() : this.#modelAccess.apply()))
      .catch((error: unknown) => {
        this.#logger.error({ err: error }, "Applying the thread's model access failed");
      });
  }

  /** A run's end is where a model switch, or a stop for want of a key, can happen. */
  #catchUpWithModelAccess(): void {
    if (!this.#isStopped && this.#modelAccess.isOutOfStep()) {
      this.#queueApplyingModelAccess();
    }
  }

  /**
   * Clears Pi's queue before aborting, because `abort` alone leaves queued
   * messages in place and Pi would answer them at the end of the next run.
   * Pi answers `abort` only once the agent is idle.
   * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
   */
  async #interruptPi(): Promise<void> {
    const piProcess = this.#pi.current;
    if (piProcess === undefined) {
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
    const access = this.#modelAccess.latest;
    if (!isModelAccessUsable(access)) {
      this.#logger.warn(
        { messageId: message.messageId },
        "Answering a user message with no model access",
      );
      this.#runReporter.reportUnansweredMessage(
        describeMissingModelAccess(access),
        "credential_missing",
      );
      return;
    }
    const piProcess = await this.#pi.ensureRunning(access);
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
      this.#runReporter.noteMessageAccepted();
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
      this.#runReporter.reportUnansweredMessage(
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

  #dropUndeliveredUserMessages(reason: string): void {
    for (const message of this.#undeliveredUserMessages) {
      this.#logger.info({ messageId: message.messageId, reason }, "Dropped a user message");
    }
    this.#undeliveredUserMessages.clear();
  }
}
