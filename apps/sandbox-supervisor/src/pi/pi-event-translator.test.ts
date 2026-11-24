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
  let currentState = state;
  for (const event of events) {
    const translation = translatePiEvent(currentState, event, mintIdentifier);
    currentState = translation.state;
    messages.push(...translation.messages);
    unrecognized.push(...translation.unrecognized);
  }
  return { messages, unrecognized, state: currentState };
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

  it("reports Pi's retries, with their several agent_end events, as one run that settles once", () => {
    const { messages } = translateFixture("retried-run");

    const eventTypes = agentEvents(messages).map((event) => event.type);
    expect(eventTypes).toEqual([
      "agent_run_started",
      "assistant_message",
      "assistant_message",
      "assistant_message",
      "assistant_message",
      "agent_run_settled",
    ]);
    expect(
      readFixtureEvents("retried-run").filter((event) => event.type === "agent_start"),
    ).toHaveLength(4);
  });

  it("produces only messages that satisfy the protocol", () => {
    for (const fixtureName of [
      "plain-reply",
      "tool-call",
      "provider-error",
      "interrupted-run",
      "retried-run",
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
