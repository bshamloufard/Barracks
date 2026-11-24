/**
 * Tells the supervisor, in the harness's vocabulary, what Pi did: its
 * events and its exits, translated, and the harness's own reports of a
 * message the agent could not take or an agent that failed. Keeps track of
 * whether a run is in progress, which decides when Pi may be started again.
 */

import {
  type AgentEvent,
  type ModelAccessErrorKind,
  maximumErrorMessageLength,
} from "@barrack/protocol";
import type { AgentHarnessObserver } from "../agent-harness.js";
import type { Logger } from "../logger.js";
import {
  initialTranslationState,
  type Translation,
  type TranslationState,
  translatePiEvent,
  translatePiExit,
} from "./pi-event-translator.js";
import type { PiExit } from "./pi-process.js";
import type { PiEvent } from "./pi-records.js";

export type PiRunReporterSettings = {
  observer: AgentHarnessObserver;
  logger: Logger;
  mintIdentifier: () => string;
  /** A run has just ended: where a model switch, or a stop for want of a key, can happen. */
  onRunEnded: () => void;
};

export class PiRunReporter {
  readonly #settings: PiRunReporterSettings;
  readonly #logger: Logger;
  #translationState: TranslationState = initialTranslationState;
  /** From a prompt Pi accepted until its run ends, so Pi is never restarted under a run. */
  #isRunInProgress = false;

  constructor(settings: PiRunReporterSettings) {
    this.#settings = settings;
    this.#logger = settings.logger;
  }

  get isRunInProgress(): boolean {
    return this.#isRunInProgress;
  }

  /** Pi accepted a prompt, so a run is under way even before Pi says it started. */
  noteMessageAccepted(): void {
    this.#isRunInProgress = true;
  }

  reportPiEvent(event: PiEvent): void {
    this.#applyTranslation(
      translatePiEvent(this.#translationState, event, this.#settings.mintIdentifier),
    );
  }

  reportPiExit(exit: PiExit): void {
    this.#applyTranslation(translatePiExit(this.#translationState, exit.wasRequested));
    this.#isRunInProgress = false;
    if (exit.wasRequested) {
      this.#logger.info({ description: exit.description }, "Pi stopped");
      this.#settings.observer.onAgentProcessEnded({
        wasExpected: true,
        description: exit.description,
      });
      return;
    }
    const diagnostics = exit.recentDiagnostics.trim();
    const restartNote = "It will be started again on the next message.";
    this.reportAgentFailure(
      diagnostics.length === 0
        ? `${exit.description} ${restartNote}`
        : `${exit.description} ${restartNote} Its last diagnostics:\n${diagnostics}`,
    );
    this.#settings.observer.onAgentProcessEnded({
      wasExpected: false,
      description: exit.description,
    });
  }

  reportAgentFailure(description: string): void {
    this.#logger.error({ description }, "The agent failed");
    this.#emitEvent({ type: "agent_failed", errorMessage: limitErrorMessage(description) });
  }

  /**
   * A message the agent cannot take (Pi refused it, or there is no key)
   * would otherwise leave the user waiting for a reply that never comes. It
   * is shown the way a model provider error is: an assistant message that
   * ended in an error, inside a run of its own when the agent was idle.
   */
  reportUnansweredMessage(errorMessage: string, errorKind: ModelAccessErrorKind | undefined): void {
    const isIdle = !this.#translationState.isRunActive;
    if (isIdle) {
      this.#emitEvent({ type: "agent_run_started" });
    }
    this.#emitEvent({
      type: "assistant_message",
      messageId: this.#settings.mintIdentifier(),
      content: [],
      endReason: "errored",
      errorMessage: limitErrorMessage(errorMessage),
      ...(errorKind === undefined ? {} : { errorKind }),
    });
    if (isIdle) {
      this.#emitEvent({ type: "agent_run_settled", wasInterrupted: false });
    }
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
        this.#settings.observer.onStreamFragment(message.fragment);
      }
    }
  }

  #noteRunProgress(event: AgentEvent): void {
    if (event.type === "agent_run_started") {
      this.#isRunInProgress = true;
      return;
    }
    if (event.type !== "agent_run_settled" && event.type !== "agent_failed") {
      return;
    }
    this.#isRunInProgress = false;
    this.#settings.onRunEnded();
  }

  #emitEvent(event: AgentEvent): void {
    this.#settings.observer.onAgentEvent(event);
  }
}

function limitErrorMessage(errorMessage: string): string {
  return errorMessage.slice(0, maximumErrorMessageLength);
}
