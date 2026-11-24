import {
  type AgentEvent,
  type AgentEventMessage,
  type AssistantContentBlock,
  type AssistantMessageEvent,
  maximumFrameLength,
  type ToolArguments,
} from "@barrack/protocol";
import { shortenText } from "./shorten-text.js";

/**
 * The control plane refuses a frame longer than `maximumFrameLength` and
 * closes the connection for it, losing the event. It then forwards each
 * event to viewers inside a slightly larger envelope (its sequence and the
 * time it was recorded), which has to fit the same limit, so supervisor
 * frames leave room for that.
 */
const viewerEnvelopeAllowance = 1024;
export const maximumSupervisorFrameLength = maximumFrameLength - viewerEnvelopeAllowance;

/**
 * Below this many characters per content block, a cut-down message would
 * say too little to be worth keeping, so it is replaced by a notice instead.
 */
const minimumLengthPerContentBlock = 1024;

/**
 * Lengths are cut in characters but measured in JSON, where the line breaks
 * around the omission marker take two characters each. Text that is mostly
 * escaped characters needs far more, and ends up as a notice instead.
 */
const escapingAllowancePerBlock = 16;

/** A model's text is read from the top, so most of what is kept comes from its start. */
const keptShareFromStartOfModelText = 0.75;

/** The key of the one entry left in tool arguments too large to record. */
export const omittedArgumentsNoteKey = "barrackNote";

export function measureAgentEventFrame(event: AgentEvent): number {
  const message: AgentEventMessage = { type: "agent_event", event };
  return JSON.stringify(message).length;
}

/**
 * Returns `event` unchanged when its frame fits, and otherwise a smaller
 * event that says what was left out, so nothing is silently lost.
 *
 * Only two kinds of event have fields the protocol leaves unbounded: an
 * assistant message (the model's text, thinking and tool call arguments)
 * and the start of a tool execution (its arguments). Every other event is
 * bounded by the protocol far below a frame.
 */
export function fitAgentEventInFrame(
  event: AgentEvent,
  maximumLength = maximumSupervisorFrameLength,
): AgentEvent {
  if (measureAgentEventFrame(event) <= maximumLength) {
    return event;
  }
  switch (event.type) {
    case "assistant_message":
      return fitAssistantMessage(event, maximumLength);
    case "tool_execution_started":
      return { ...event, arguments: describeOmittedArguments(event.arguments) };
    default:
      return event;
  }
}

/**
 * Gives every content block an equal share of the room, cutting the middle
 * out of long text and replacing large tool call arguments with a note. A
 * message with so many blocks that each share is too small to be useful,
 * or that is still too large once cut (text full of characters JSON must
 * escape), becomes a notice that it was too large to record.
 */
function fitAssistantMessage(
  event: AssistantMessageEvent,
  maximumLength: number,
): AssistantMessageEvent {
  const emptiedMessage = { ...event, content: event.content.map(emptyContentBlock) };
  const roomForContent = maximumLength - measureAgentEventFrame(emptiedMessage);
  const lengthPerContentBlock =
    Math.floor(roomForContent / Math.max(1, event.content.length)) - escapingAllowancePerBlock;
  if (lengthPerContentBlock >= minimumLengthPerContentBlock) {
    const cutMessage = {
      ...event,
      content: event.content.map((block) => cutContentBlock(block, lengthPerContentBlock)),
    };
    if (measureAgentEventFrame(cutMessage) <= maximumLength) {
      return cutMessage;
    }
  }
  return replaceContentWithNotice(event, maximumLength);
}

function emptyContentBlock(block: AssistantContentBlock): AssistantContentBlock {
  return block.type === "tool_call" ? { ...block, arguments: {} } : { ...block, text: "" };
}

function cutContentBlock(
  block: AssistantContentBlock,
  maximumLength: number,
): AssistantContentBlock {
  if (block.type !== "tool_call") {
    return {
      ...block,
      text: shortenText(block.text, maximumLength, keptShareFromStartOfModelText),
    };
  }
  if (JSON.stringify(block.arguments).length <= maximumLength) {
    return block;
  }
  return { ...block, arguments: describeOmittedArguments(block.arguments) };
}

function describeOmittedArguments(toolArguments: ToolArguments): ToolArguments {
  const argumentsLength = JSON.stringify(toolArguments).length;
  return {
    [omittedArgumentsNoteKey]: `These arguments were ${argumentsLength} characters long, too large to record.`,
  };
}

function replaceContentWithNotice(
  event: AssistantMessageEvent,
  maximumLength: number,
): AssistantMessageEvent {
  const originalLength = measureAgentEventFrame(event);
  const notice = `[This message was ${originalLength} characters long, more than the ${maximumLength} that can be recorded at once, so its content was left out.]`;
  return { ...event, content: [{ type: "text", text: notice }] };
}
