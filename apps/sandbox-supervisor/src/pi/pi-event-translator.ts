import {
  type AgentEvent,
  type AssistantContentBlock,
  type AssistantMessageEndReason,
  type AssistantMessageEvent,
  maximumErrorMessageLength,
  type StreamFragment,
  type SupervisorToControlPlaneMessage,
} from "@barrack/protocol";
import type {
  PiAssistantContentBlock,
  PiAssistantMessage,
  PiEvent,
  PiMessage,
} from "./pi-records.js";
import { flattenToolResultContent, truncateToolOutput } from "./tool-output.js";

/**
 * Translates Pi's events into Barrack's vocabulary. It is pure: the caller
 * holds the state between events and sends and logs what comes back, which
 * keeps every rule here testable with recorded Pi transcripts.
 *
 * Pi's run lifecycle is the subtle part. One user-visible run can contain
 * several `agent_start`/`agent_end` pairs (automatic retries, compaction,
 * queued messages), and only `agent_settled` means Pi is done.
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
 *
 * Retries are the other. When a model request fails with an error Pi
 * considers temporary (overloaded, rate limited, a dropped connection), or
 * because the context outgrew the model, Pi removes the failed attempt from
 * the model's context and tries again. Recording each attempt would show one
 * passing failure as several errors, even when a retry then succeeds. So an
 * assistant message that ended in an error is held back until Pi says
 * whether it will retry: it is dropped when the retry starts, and recorded
 * as soon as anything shows no retry is coming.
 */

/**
 * What Pi has said so far about retrying a failed request, in the order it
 * says it:
 * - `awaiting_run_end`: nothing yet; `agent_end.willRetry` comes next.
 * - `awaiting_recovery`: no automatic retry, but if the context overflowed,
 *   Pi compacts it and retries, and starts compacting straight away.
 * - `compacting_after_overflow`: `compaction_end.willRetry` will decide.
 * - `retry_announced`: the next `agent_start` is the retry.
 */
type RetryOutlook =
  | "awaiting_run_end"
  | "awaiting_recovery"
  | "compacting_after_overflow"
  | "retry_announced";

type ErroredAssistantMessageEvent = AssistantMessageEvent & { errorMessage: string };

type HeldErroredMessage = { event: ErroredAssistantMessageEvent; retryOutlook: RetryOutlook };

export type TranslationState = {
  /** Between the first `agent_start` after idle and the `agent_settled` that ends the run. */
  isRunActive: boolean;
  /**
   * Pi's messages carry no identifier, so one is minted when an assistant
   * message starts and reused for its fragments and its completed event.
   */
  currentAssistantMessageId: string | undefined;
  heldErroredMessage: HeldErroredMessage | undefined;
};

export const initialTranslationState: TranslationState = {
  isRunActive: false,
  currentAssistantMessageId: undefined,
  heldErroredMessage: undefined,
};

export type Translation = {
  state: TranslationState;
  messages: SupervisorToControlPlaneMessage[];
  /** Things Pi sent that this translation does not know, for the caller to log. */
  unrecognized: string[];
  /** Model provider errors Pi is retrying, which are not recorded, for the caller to log. */
  retriedErrorMessages: string[];
};

export function translatePiEvent(
  state: TranslationState,
  event: PiEvent,
  mintIdentifier: () => string,
): Translation {
  const heldMessageOutcome = resolveHeldErroredMessage(state, event);
  const translation = translateEvent(heldMessageOutcome.state, event, mintIdentifier);
  return {
    state: translation.state,
    messages: [...heldMessageOutcome.messages, ...translation.messages],
    unrecognized: translation.unrecognized,
    retriedErrorMessages: heldMessageOutcome.retriedErrorMessages,
  };
}

/**
 * Records a held errored message now, for when no more events will come
 * because Pi's process has ended.
 */
export function releaseHeldErroredMessage(state: TranslationState): Translation {
  const held = state.heldErroredMessage;
  if (held === undefined) {
    return nothing(state);
  }
  return emit({ ...state, heldErroredMessage: undefined }, held.event);
}

function resolveHeldErroredMessage(state: TranslationState, event: PiEvent): Translation {
  const held = state.heldErroredMessage;
  if (held === undefined) {
    return nothing(state);
  }
  const nextOutlook = foreseeRetry(held.retryOutlook, event);
  if (nextOutlook === "retry_started") {
    return {
      ...nothing({ ...state, heldErroredMessage: undefined }),
      retriedErrorMessages: [held.event.errorMessage],
    };
  }
  if (nextOutlook === "no_retry") {
    return releaseHeldErroredMessage(state);
  }
  return nothing({ ...state, heldErroredMessage: { ...held, retryOutlook: nextOutlook } });
}

/** Anything Pi sends out of the order described on `RetryOutlook` means no retry is coming. */
function foreseeRetry(
  outlook: RetryOutlook,
  event: PiEvent,
): RetryOutlook | "retry_started" | "no_retry" {
  if (outlook === "awaiting_run_end" && event.type === "agent_end") {
    return event.willRetry ? "retry_announced" : "awaiting_recovery";
  }
  if (
    outlook === "awaiting_recovery" &&
    event.type === "compaction_start" &&
    event.reason === "overflow"
  ) {
    return "compacting_after_overflow";
  }
  if (outlook === "compacting_after_overflow" && event.type === "compaction_end") {
    return event.willRetry ? "retry_announced" : "no_retry";
  }
  if (outlook === "retry_announced" && event.type === "agent_start") {
    return "retry_started";
  }
  return "no_retry";
}

function translateEvent(
  state: TranslationState,
  event: PiEvent,
  mintIdentifier: () => string,
): Translation {
  switch (event.type) {
    case "agent_end":
    case "compaction_start":
    case "compaction_end":
      return nothing(state);
    case "agent_start":
      return translateAgentStart(state);
    case "agent_settled":
      return translateAgentSettled(state, event.aborted);
    case "message_start":
      return translateMessageStart(state, event.message, mintIdentifier);
    case "message_update":
      return translateMessageUpdate(state, event.assistantMessageEvent);
    case "message_end":
      return translateMessageEnd(state, event.message, mintIdentifier);
    case "tool_execution_start":
      return emit(state, {
        type: "tool_execution_started",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        arguments: event.args,
      });
    case "tool_execution_end":
      return emit(state, {
        type: "tool_execution_finished",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        output: truncateToolOutput(flattenToolResultContent(event.result.content)),
        ...(event.durationMs === undefined
          ? {}
          : { durationInMilliseconds: Math.round(event.durationMs) }),
      });
  }
}

/** Only the first `agent_start` after idle starts a run; later ones are Pi retrying or continuing. */
function translateAgentStart(state: TranslationState): Translation {
  if (state.isRunActive) {
    return nothing(state);
  }
  return emit({ ...state, isRunActive: true }, { type: "agent_run_started" });
}

function translateAgentSettled(state: TranslationState, wasAborted: boolean): Translation {
  if (!state.isRunActive) {
    return nothing(state);
  }
  return emit(initialTranslationState, { type: "agent_run_settled", wasInterrupted: wasAborted });
}

function translateMessageStart(
  state: TranslationState,
  message: PiMessage,
  mintIdentifier: () => string,
): Translation {
  if ("otherRole" in message) {
    return nothing(state);
  }
  return nothing({ ...state, currentAssistantMessageId: mintIdentifier() });
}

type PiAssistantMessageEvent = Extract<
  PiEvent,
  { type: "message_update" }
>["assistantMessageEvent"];

const fragmentBlockTypeByDeltaType: Record<string, StreamFragment["contentBlockType"]> = {
  text_delta: "text",
  thinking_delta: "thinking",
};

/** Text and thinking deltas become fragments. Tool call argument deltas are not shown while streaming. */
function translateMessageUpdate(
  state: TranslationState,
  assistantMessageEvent: PiAssistantMessageEvent,
): Translation {
  const contentBlockType = fragmentBlockTypeByDeltaType[assistantMessageEvent.type];
  const { contentIndex, delta } = assistantMessageEvent;
  const messageId = state.currentAssistantMessageId;
  if (contentBlockType === undefined || contentIndex === undefined || delta === undefined) {
    return nothing(state);
  }
  if (messageId === undefined) {
    return nothing(state);
  }
  return {
    ...nothing(state),
    messages: [
      {
        type: "stream_fragment",
        fragment: {
          type: "assistant_text_fragment",
          messageId,
          contentBlockIndex: contentIndex,
          contentBlockType,
          appendedText: delta,
        },
      },
    ],
  };
}

/**
 * Only assistant messages are forwarded. The control plane records user
 * messages itself, and tool results travel in `tool_execution_finished`.
 */
function translateMessageEnd(
  state: TranslationState,
  message: PiMessage,
  mintIdentifier: () => string,
): Translation {
  if ("otherRole" in message) {
    return nothing(state);
  }
  const messageId = state.currentAssistantMessageId ?? mintIdentifier();
  const content = translateContent(message.content);
  const ending = translateEnding(message);
  const event: AssistantMessageEvent = {
    type: "assistant_message",
    messageId,
    ...ending.fields,
    content: content.blocks,
  };
  const unrecognized = [...content.unrecognized, ...ending.unrecognized];
  const nextState = { ...state, currentAssistantMessageId: undefined };
  if (isErrored(event)) {
    const heldErroredMessage: HeldErroredMessage = { event, retryOutlook: "awaiting_run_end" };
    return { ...nothing({ ...nextState, heldErroredMessage }), unrecognized };
  }
  return { ...emit(nextState, event), unrecognized };
}

function isErrored(event: AssistantMessageEvent): event is ErroredAssistantMessageEvent {
  return event.endReason === "errored" && event.errorMessage !== undefined;
}

/**
 * Pi's content indexes are kept: fragments refer to blocks by position, so
 * the only blocks dropped are kinds this translation does not know.
 */
function translateContent(piBlocks: PiAssistantContentBlock[]): {
  blocks: AssistantContentBlock[];
  unrecognized: string[];
} {
  const blocks: AssistantContentBlock[] = [];
  const unrecognized: string[] = [];
  for (const block of piBlocks) {
    if ("unrecognized" in block) {
      unrecognized.push(`assistant content block of type "${block.unrecognized}"`);
      continue;
    }
    blocks.push(translateContentBlock(block));
  }
  return { blocks, unrecognized };
}

function translateContentBlock(
  block: Exclude<PiAssistantContentBlock, { unrecognized: string }>,
): AssistantContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "thinking", text: block.thinking };
    case "toolCall":
      return {
        type: "tool_call",
        toolCallId: block.id,
        toolName: block.name,
        arguments: block.arguments,
      };
  }
}

const endReasonByStopReason: Record<string, AssistantMessageEndReason> = {
  stop: "completed",
  toolUse: "tool_use_requested",
  length: "length_limit_reached",
  error: "errored",
  aborted: "interrupted",
};

type Ending = Pick<AssistantMessageEvent, "endReason" | "errorMessage">;

/**
 * Pi's other stop reasons (`pending`, `deferred`) do not occur on a completed
 * message in an agent run, so anything unknown is treated as completed and
 * reported.
 */
function translateEnding(message: PiAssistantMessage): {
  fields: Ending;
  unrecognized: string[];
} {
  const endReason = endReasonByStopReason[message.stopReason];
  if (endReason === undefined) {
    return {
      fields: { endReason: "completed" },
      unrecognized: [`assistant stop reason "${message.stopReason}"`],
    };
  }
  if (endReason !== "errored") {
    return { fields: { endReason }, unrecognized: [] };
  }
  return {
    fields: { endReason, errorMessage: describeProviderError(message.errorMessage) },
    unrecognized: [],
  };
}

function describeProviderError(errorMessage: string | undefined): string {
  if (errorMessage === undefined || errorMessage.length === 0) {
    return "The model provider reported an error without a message.";
  }
  return errorMessage.slice(0, maximumErrorMessageLength);
}

function emit(state: TranslationState, event: AgentEvent): Translation {
  return { ...nothing(state), messages: [{ type: "agent_event", event }] };
}

function nothing(state: TranslationState): Translation {
  return { state, messages: [], unrecognized: [], retriedErrorMessages: [] };
}
