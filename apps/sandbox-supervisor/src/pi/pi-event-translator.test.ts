import { readFileSync } from "node:fs";
import {
  type SupervisorToControlPlaneMessage,
  supervisorToControlPlaneMessageSchema,
} from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import {
  initialTranslationState,
  type TranslationState,
  translatePiEvent,
  translatePiExit,
} from "./pi-event-translator.js";
import { type PiEvent, parsePiRecord } from "./pi-records.js";

/**
 * The fixtures are Pi 1.6.0's stdout from real runs against a local mock
 * model, trimmed of payloads the supervisor ignores (the system prompt and
 * the message copies in `turn_end` and `agent_end`).
 */
function readFixtureEvents(fixtureName: string): PiEvent[] {
  const fixtureText = readFileSync(
    new URL(`./fixtures/${fixtureName}.jsonl`, import.meta.url),
    "utf8",
  );
  return fixtureText
    .trim()
    .split("\n")
    .flatMap((line) => {
      const parsed = parsePiRecord(line);
      if (!parsed.ok) {
        throw new Error(`Fixture ${fixtureName} has an unreadable line: ${parsed.errorMessage}`);
      }
      return parsed.value.kind === "event" ? [parsed.value.event] : [];
    });
}

function translateAll(events: PiEvent[], state: TranslationState = initialTranslationState) {
  let identifierCount = 0;
  const mintIdentifier = () => `minted-${++identifierCount}`;
  const messages: SupervisorToControlPlaneMessage[] = [];
  const unrecognized: string[] = [];
  const retriedErrorMessages: string[] = [];
  let currentState = state;
  for (const event of events) {
    const translation = translatePiEvent(currentState, event, mintIdentifier);
    currentState = translation.state;
    messages.push(...translation.messages);
    unrecognized.push(...translation.unrecognized);
    retriedErrorMessages.push(...translation.retriedErrorMessages);
  }
  return { messages, unrecognized, retriedErrorMessages, state: currentState };
}

function translateFixture(fixtureName: string) {
  return translateAll(readFixtureEvents(fixtureName));
}

function describeMessages(messages: SupervisorToControlPlaneMessage[]): string[] {
  return messages.map((message) =>
    message.type === "agent_event"
      ? message.event.type
      : `fragment:${message.fragment.appendedText}`,
  );
}

function agentEvents(messages: SupervisorToControlPlaneMessage[]) {
  return messages.flatMap((message) => (message.type === "agent_event" ? [message.event] : []));
}

describe("translatePiEvent", () => {
  it("turns a plain reply into run started, its fragments, the completed message and run settled", () => {
    const { messages } = translateFixture("plain-reply");

    expect(messages).toEqual([
      { type: "agent_event", event: { type: "agent_run_started" } },
      fragment("minted-1", "Hello"),
      fragment("minted-1", " there."),
      {
        type: "agent_event",
        event: {
          type: "assistant_message",
          messageId: "minted-1",
          content: [{ type: "text", text: "Hello there." }],
          endReason: "completed",
        },
      },
      { type: "agent_event", event: { type: "agent_run_settled", wasInterrupted: false } },
    ]);
  });

  it("reports a tool call as the model's request, the execution, and the reply that follows", () => {
    const { messages } = translateFixture("tool-call");

    expect(describeMessages(messages)).toEqual([
      "agent_run_started",
      "fragment:Running it.",
      "assistant_message",
      "tool_execution_started",
      "tool_execution_finished",
      "fragment:Hello",
      "fragment: there.",
      "assistant_message",
      "agent_run_settled",
    ]);
    const [, toolRequest, toolStarted, toolFinished, reply] = agentEvents(messages);
    expect(toolRequest).toEqual({
      type: "assistant_message",
      messageId: "minted-1",
      content: [
        { type: "text", text: "Running it." },
        {
          type: "tool_call",
          toolCallId: "call_1",
          toolName: "bash",
          arguments: { command: "echo hi" },
        },
      ],
      endReason: "tool_use_requested",
    });
    expect(toolStarted).toEqual({
      type: "tool_execution_started",
      toolCallId: "call_1",
      toolName: "bash",
      arguments: { command: "echo hi" },
    });
    expect(toolFinished).toEqual({
      type: "tool_execution_finished",
      toolCallId: "call_1",
      toolName: "bash",
      isError: false,
      output: { text: "hi\n", isTruncated: false, originalSizeInBytes: 3 },
      durationInMilliseconds: 8,
    });
    expect(reply).toMatchObject({ messageId: "minted-2", endReason: "completed" });
  });

  it("does not forward user messages or tool result messages", () => {
    const { messages } = translateFixture("tool-call");

    const assistantMessages = agentEvents(messages).filter(
      (event) => event.type === "assistant_message",
    );
    expect(assistantMessages).toHaveLength(2);
  });

  it("ends the assistant message as errored, with the provider's message, when the provider fails", () => {
    const { messages } = translateFixture("provider-error");

    expect(agentEvents(messages)).toEqual([
      { type: "agent_run_started" },
      {
        type: "assistant_message",
        messageId: "minted-1",
        content: [],
        endReason: "errored",
        errorMessage:
          '401: {"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}',
      },
      { type: "agent_run_settled", wasInterrupted: false },
    ]);
  });

  it("ends an interrupted run's partial message as interrupted and settles the run as interrupted", () => {
    const { messages } = translateFixture("interrupted-run");

    const events = agentEvents(messages);
    expect(events).toEqual([
      { type: "agent_run_started" },
      {
        type: "assistant_message",
        messageId: "minted-1",
        content: [{ type: "text", text: "One two " }],
        endReason: "interrupted",
      },
      { type: "agent_run_settled", wasInterrupted: true },
    ]);
  });

  it("records only the last error when every one of Pi's retries fails, in one run that settles once", () => {
    const { messages, retriedErrorMessages } = translateFixture("retried-run");

    expect(agentEvents(messages)).toEqual([
      { type: "agent_run_started" },
      {
        type: "assistant_message",
        messageId: "minted-4",
        content: [],
        endReason: "errored",
        errorMessage: expect.stringContaining("Proxy response (403)"),
      },
      { type: "agent_run_settled", wasInterrupted: false },
    ]);
    expect(retriedErrorMessages).toHaveLength(3);
    expect(
      readFixtureEvents("retried-run").filter((event) => event.type === "agent_start"),
    ).toHaveLength(4);
  });

  it("records no error when Pi retries a failed request and the retry succeeds", () => {
    const { messages, retriedErrorMessages } = translateFixture("retried-then-answered-run");

    expect(agentEvents(messages)).toEqual([
      { type: "agent_run_started" },
      {
        type: "assistant_message",
        messageId: "minted-2",
        content: [{ type: "text", text: "Hello there." }],
        endReason: "completed",
      },
      { type: "agent_run_settled", wasInterrupted: false },
    ]);
    expect(retriedErrorMessages).toEqual(['503: {"message":"The model is overloaded."}']);
  });

  it("records no error when Pi compacts an overflowing context and the retry succeeds", () => {
    const { messages, retriedErrorMessages } = translateFixture("overflow-recovered-run");

    expect(agentEvents(messages).map((event) => event.type)).toEqual([
      "agent_run_started",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(agentEvents(messages)[1]).toMatchObject({ endReason: "completed" });
    expect(retriedErrorMessages).toEqual([expect.stringContaining("exceeds the context window")]);
  });

  it("records the error when the user interrupts while Pi waits to retry", () => {
    const { messages } = translateFixture("interrupted-retry");

    expect(agentEvents(messages)).toEqual([
      { type: "agent_run_started" },
      {
        type: "assistant_message",
        messageId: "minted-1",
        content: [],
        endReason: "errored",
        errorMessage: '503: {"message":"The model is overloaded."}',
      },
      { type: "agent_run_settled", wasInterrupted: true },
    ]);
  });

  it("holds an errored message back until what Pi does next shows no retry is coming", () => {
    const erroredMessageEnd: PiEvent = {
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401" },
    };
    const afterMessage = translateAll([{ type: "agent_start" }, erroredMessageEnd]);
    // No automatic retry, but Pi could still compact an overflowing context and retry.
    const afterRun = translateAll([{ type: "agent_end", willRetry: false }], afterMessage.state);
    const afterSettling = translateAll([{ type: "agent_settled", aborted: false }], afterRun.state);

    expect(agentEvents(afterMessage.messages).map((event) => event.type)).toEqual([
      "agent_run_started",
    ]);
    expect(afterRun.messages).toEqual([]);
    expect(agentEvents(afterSettling.messages)).toEqual([
      expect.objectContaining({ endReason: "errored", errorMessage: "401" }),
      { type: "agent_run_settled", wasInterrupted: false },
    ]);
  });

  it("never holds back a message that did not end in an error", () => {
    const { messages } = translateAll([
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Hi" }], stopReason: "stop" },
      },
    ]);

    expect(agentEvents(messages)).toEqual([expect.objectContaining({ endReason: "completed" })]);
  });

  it("records an error Pi does not retry before the run carries on with a queued message", () => {
    const { messages } = translateAll([
      { type: "agent_start" },
      {
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401" },
      },
      { type: "agent_end", willRetry: false },
      { type: "agent_start" },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Hi" }], stopReason: "stop" },
      },
      { type: "agent_end", willRetry: false },
      { type: "agent_settled", aborted: false },
    ]);

    expect(agentEvents(messages).map((event) => event.type)).toEqual([
      "agent_run_started",
      "assistant_message",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(agentEvents(messages)[1]).toMatchObject({ endReason: "errored" });
  });

  it("records a held error when compacting after an overflow will not retry", () => {
    const { messages } = translateAll([
      { type: "agent_start" },
      {
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "too long" },
      },
      { type: "agent_end", willRetry: false },
      { type: "compaction_start", reason: "overflow" },
      { type: "compaction_end", willRetry: false },
      { type: "agent_settled", aborted: false },
    ]);

    expect(agentEvents(messages).map((event) => event.type)).toEqual([
      "agent_run_started",
      "assistant_message",
      "agent_run_settled",
    ]);
  });

  it("records a held error when Pi's process ends", () => {
    const { state } = translateAll([
      { type: "agent_start" },
      {
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503" },
      },
    ]);

    const translation = translatePiExit(state, false);

    expect(agentEvents(translation.messages)).toEqual([
      expect.objectContaining({ endReason: "errored", errorMessage: "503" }),
    ]);
    expect(translation.state).toEqual(initialTranslationState);
  });

  it("settles an open run as interrupted when Pi stops because it was asked to", () => {
    const { state } = translateAll([{ type: "agent_start" }]);

    const translation = translatePiExit(state, true);

    expect(agentEvents(translation.messages)).toEqual([
      { type: "agent_run_settled", wasInterrupted: true },
    ]);
    expect(translation.state).toEqual(initialTranslationState);
  });

  it("leaves ending the run to agent_failed when Pi exits unexpectedly", () => {
    const { state } = translateAll([{ type: "agent_start" }]);

    expect(translatePiExit(state, false).messages).toEqual([]);
  });

  it("reports nothing when Pi stops while idle", () => {
    expect(translatePiExit(initialTranslationState, true).messages).toEqual([]);
  });

  it("produces only messages that satisfy the protocol", () => {
    for (const fixtureName of [
      "plain-reply",
      "tool-call",
      "provider-error",
      "interrupted-run",
      "retried-run",
      "retried-then-answered-run",
      "overflow-recovered-run",
      "interrupted-retry",
    ]) {
      for (const message of translateFixture(fixtureName).messages) {
        expect(supervisorToControlPlaneMessageSchema.safeParse(message).success).toBe(true);
      }
    }
  });

  it("ignores agent_settled when no run is in progress", () => {
    const { messages } = translateAll([{ type: "agent_settled", aborted: false }]);

    expect(messages).toEqual([]);
  });

  it("treats a stop reason it does not know as completed and reports it", () => {
    const { messages, unrecognized } = translateAll([
      { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Later." }],
          stopReason: "deferred",
        },
      },
    ]);

    expect(agentEvents(messages)).toEqual([
      {
        type: "assistant_message",
        messageId: "minted-1",
        content: [{ type: "text", text: "Later." }],
        endReason: "completed",
      },
    ]);
    expect(unrecognized).toEqual(['assistant stop reason "deferred"']);
  });

  it("carries thinking as thinking blocks and thinking fragments", () => {
    const { messages } = translateAll([
      { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Hmm" },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Hmm" }],
          stopReason: "stop",
        },
      },
    ]);

    expect(messages).toEqual([
      {
        type: "stream_fragment",
        fragment: {
          type: "assistant_text_fragment",
          messageId: "minted-1",
          contentBlockIndex: 0,
          contentBlockType: "thinking",
          appendedText: "Hmm",
        },
      },
      {
        type: "agent_event",
        event: {
          type: "assistant_message",
          messageId: "minted-1",
          content: [{ type: "thinking", text: "Hmm" }],
          endReason: "completed",
        },
      },
    ]);
  });

  it("gives an errored message a placeholder when the provider sent no error text", () => {
    const { messages } = translateAll([
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } },
      { type: "agent_settled", aborted: false },
    ]);

    expect(agentEvents(messages)[0]).toMatchObject({
      endReason: "errored",
      errorMessage: "The model provider reported an error without a message.",
    });
  });
});

function fragment(messageId: string, appendedText: string): SupervisorToControlPlaneMessage {
  return {
    type: "stream_fragment",
    fragment: {
      type: "assistant_text_fragment",
      messageId,
      contentBlockIndex: 0,
      contentBlockType: "text",
      appendedText,
    },
  };
}
