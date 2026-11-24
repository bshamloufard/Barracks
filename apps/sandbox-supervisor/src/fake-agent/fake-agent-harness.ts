import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AssistantContentBlock,
  AssistantMessageEndReason,
  ModelAccessErrorKind,
} from "@barrack/protocol";
import type {
  AgentHarness,
  AgentHarnessObserver,
  ModelAccess,
  UserMessage,
} from "../agent-harness.js";
import { describeMissingModelAccess } from "../missing-model-access.js";

/**
 * A scripted agent with no model and no network, so the whole system can run
 * end to end without an API key and tests can rely on exact event order.
 *
 * For each user message it streams a reply that quotes the message. Words in
 * the message change the script, so a person driving the web page can try
 * every path:
 * - `[tool]` makes it call a tool before replying.
 * - `[fail]` makes it fail as if its process had crashed.
 * - `[model]` makes it say which model it runs on.
 * - `[quota]` makes it fail as a model provider out of quota would.
 *
 * It needs no key, but keeps to the rule a real agent cannot escape: a
 * thread given a model and no key for it is not answered, but told to add
 * one. A thread with no model at all (allowed when the installation runs
 * the fake agent) is answered as before.
 *
 * Messages that arrive while it is busy are answered in the same run, the
 * way a real agent takes up steering.
 */
export const fakeAgentTriggers = {
  toolExecution: "[tool]",
  failure: "[fail]",
  model: "[model]",
  quotaExhausted: "[quota]",
} as const;

export type FakeAgentOptions = {
  /** Pause before each step, so a viewer can watch the reply appear. */
  stepDelayInMilliseconds: number;
  mintIdentifier: () => string;
};

const defaultOptions: FakeAgentOptions = {
  stepDelayInMilliseconds: 60,
  mintIdentifier: randomUUID,
};

type MessageOutcome = "answered" | "interrupted" | "failed";

export class FakeAgentHarness implements AgentHarness {
  readonly #observer: AgentHarnessObserver;
  readonly #options: FakeAgentOptions;
  readonly #pendingMessages: UserMessage[] = [];
  #modelAccess: ModelAccess = { model: null, credential: null };
  #currentRun: { finished: Promise<void>; abortController: AbortController } | undefined;
  #isStopped = false;

  constructor(observer: AgentHarnessObserver, options: Partial<FakeAgentOptions> = {}) {
    this.#observer = observer;
    this.#options = { ...defaultOptions, ...options };
  }

  async start(): Promise<void> {
    // There is no process to start.
  }

  configureModelAccess(access: ModelAccess): void {
    this.#modelAccess = access;
  }

  deliverUserMessage(message: UserMessage): void {
    if (this.#isStopped) {
      return;
    }
    this.#pendingMessages.push(message);
    this.#startRunIfIdle();
  }

  #startRunIfIdle(): void {
    if (this.#currentRun !== undefined || this.#pendingMessages.length === 0) {
      return;
    }
    const abortController = new AbortController();
    this.#currentRun = { abortController, finished: this.#run(abortController.signal) };
  }

  async interrupt(): Promise<void> {
    this.#pendingMessages.length = 0;
    this.#currentRun?.abortController.abort();
    await this.#currentRun?.finished;
  }

  /**
   * Refuses new messages first, then interrupts, so a run in progress still
   * reports that it settled before the agent is gone.
   */
  async stop(): Promise<void> {
    this.#isStopped = true;
    await this.interrupt();
    this.#observer.onAgentProcessEnded({
      wasExpected: true,
      description: "The fake agent was stopped.",
    });
  }

  async #run(abortSignal: AbortSignal): Promise<void> {
    this.#emitEvent({ type: "agent_run_started" });
    const outcome = await this.#answerPendingMessages(abortSignal);
    this.#currentRun = undefined;
    this.#finishRun(outcome);
    // A message that arrived while an interrupted run was winding down was
    // never part of it, so it gets a run of its own.
    this.#startRunIfIdle();
  }

  /** Takes a message off the list only when it is about to be answered. */
  async #answerPendingMessages(abortSignal: AbortSignal): Promise<MessageOutcome> {
    let message = this.#pendingMessages.shift();
    while (message !== undefined) {
      const outcome = await this.#respondTo(message, abortSignal);
      if (outcome !== "answered") {
        return outcome;
      }
      message = this.#pendingMessages.shift();
    }
    return "answered";
  }

  #finishRun(outcome: MessageOutcome): void {
    if (outcome !== "failed") {
      this.#emitEvent({ type: "agent_run_settled", wasInterrupted: outcome === "interrupted" });
      return;
    }
    // A crashed agent loses whatever it had queued.
    this.#pendingMessages.length = 0;
    this.#emitEvent({
      type: "agent_failed",
      errorMessage: `The fake agent failed because the message contained ${fakeAgentTriggers.failure}.`,
    });
    this.#observer.onAgentProcessEnded({
      wasExpected: false,
      description: "The fake agent simulated a crash.",
    });
  }

  async #respondTo(message: UserMessage, abortSignal: AbortSignal): Promise<MessageOutcome> {
    const { model, credential } = this.#modelAccess;
    if (model !== null && credential === null) {
      this.#emitErroredMessage(describeMissingModelAccess(this.#modelAccess), "credential_missing");
      return "answered";
    }
    if (message.text.includes(fakeAgentTriggers.quotaExhausted)) {
      this.#emitErroredMessage(
        "429: The fake agent's provider says this account has exceeded its quota.",
        "quota_exhausted",
      );
      return "answered";
    }
    if (message.text.includes(fakeAgentTriggers.model)) {
      return this.#streamAssistantMessage(`Running on ${model ?? "no model"}.`, [], abortSignal);
    }
    if (message.text.includes(fakeAgentTriggers.failure)) {
      return (await this.#waitForNextStep(abortSignal)) ? "failed" : "interrupted";
    }
    if (message.text.includes(fakeAgentTriggers.toolExecution)) {
      const toolOutcome = await this.#runTool(message, abortSignal);
      if (toolOutcome !== "answered") {
        return toolOutcome;
      }
    }
    return this.#streamAssistantMessage(`You said: "${message.text}"`, [], abortSignal);
  }

  async #runTool(message: UserMessage, abortSignal: AbortSignal): Promise<MessageOutcome> {
    const toolCallId = this.#options.mintIdentifier();
    const toolName = "echo";
    const toolArguments = { text: message.text };
    const requestOutcome = await this.#streamAssistantMessage(
      "Let me run a tool first.",
      [{ type: "tool_call", toolCallId, toolName, arguments: toolArguments }],
      abortSignal,
    );
    if (requestOutcome !== "answered") {
      return requestOutcome;
    }
    this.#emitEvent({
      type: "tool_execution_started",
      toolCallId,
      toolName,
      arguments: toolArguments,
    });
    const hasFinished = await this.#waitForNextStep(abortSignal);
    const outputText = hasFinished ? message.text : "The tool was interrupted.";
    this.#emitEvent({
      type: "tool_execution_finished",
      toolCallId,
      toolName,
      isError: !hasFinished,
      output: {
        text: outputText,
        isTruncated: false,
        originalSizeInBytes: Buffer.byteLength(outputText),
      },
    });
    return hasFinished ? "answered" : "interrupted";
  }

  /**
   * Streams `text` word by word, then completes the message. `toolCalls`
   * follow the text in the completed message and mean the model is waiting
   * for those tools.
   */
  async #streamAssistantMessage(
    text: string,
    toolCalls: AssistantContentBlock[],
    abortSignal: AbortSignal,
  ): Promise<MessageOutcome> {
    const messageId = this.#options.mintIdentifier();
    let streamedText = "";
    for (const word of text.split(/(?<= )/)) {
      if (!(await this.#waitForNextStep(abortSignal))) {
        this.#emitAssistantMessage(
          messageId,
          [{ type: "text", text: streamedText }],
          "interrupted",
        );
        return "interrupted";
      }
      streamedText += word;
      this.#emitTextFragment(messageId, word);
    }
    const endReason: AssistantMessageEndReason =
      toolCalls.length > 0 ? "tool_use_requested" : "completed";
    this.#emitAssistantMessage(messageId, [{ type: "text", text }, ...toolCalls], endReason);
    return "answered";
  }

  #emitAssistantMessage(
    messageId: string,
    content: AssistantContentBlock[],
    endReason: Exclude<AssistantMessageEndReason, "errored">,
  ): void {
    this.#emitEvent({ type: "assistant_message", messageId, content, endReason });
  }

  #emitErroredMessage(errorMessage: string, errorKind: ModelAccessErrorKind): void {
    this.#emitEvent({
      type: "assistant_message",
      messageId: this.#options.mintIdentifier(),
      content: [],
      endReason: "errored",
      errorMessage,
      errorKind,
    });
  }

  #emitTextFragment(messageId: string, appendedText: string): void {
    this.#observer.onStreamFragment({
      type: "assistant_text_fragment",
      messageId,
      contentBlockIndex: 0,
      contentBlockType: "text",
      appendedText,
    });
  }

  #emitEvent(event: AgentEvent): void {
    this.#observer.onAgentEvent(event);
  }

  /** Resolves `true` after the step delay, or `false` as soon as the run is interrupted. */
  #waitForNextStep(abortSignal: AbortSignal): Promise<boolean> {
    if (abortSignal.aborted) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve(true);
      }, this.#options.stepDelayInMilliseconds);
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
