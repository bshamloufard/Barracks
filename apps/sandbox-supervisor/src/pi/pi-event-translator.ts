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
 */

export type TranslationState = {
  /** Between the first `agent_start` after idle and the `agent_settled` that ends the run. */
  isRunActive: boolean;
  /**
   * Pi's messages carry no identifier, so one is minted when an assistant
   * message starts and reused for its fragments and its completed event.
   */
  currentAssistantMessageId: string | undefined;
};

export const initialTranslationState: TranslationState = {
  isRunActive: false,
  currentAssistantMessageId: undefined,
};

export type Translation = {
  state: TranslationState;
  messages: SupervisorToControlPlaneMessage[];
  /** Things Pi sent that this translation does not know, for the caller to log. */
  unrecognized: string[];
};

export function translatePiEvent(
  state: TranslationState,
  event: PiEvent,
  mintIdentifier: () => string,
): Translation {
  switch (event.type) {
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
    state,
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
    unrecognized: [],
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
  return {
    state: { ...state, currentAssistantMessageId: undefined },
    messages: [{ type: "agent_event", event }],
    unrecognized: [...content.unrecognized, ...ending.unrecognized],
  };
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
  return { state, messages: [{ type: "agent_event", event }], unrecognized: [] };
}

function nothing(state: TranslationState): Translation {
  return { state, messages: [], unrecognized: [] };
}
