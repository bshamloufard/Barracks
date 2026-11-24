import { z } from "zod";
import {
  assistantContentBlockSchema,
  toolArgumentsSchema,
  toolNameSchema,
} from "./assistant-content.js";
import { identifierSchema } from "./identifier.js";
import { maximumErrorMessageLength, maximumToolOutputLength } from "./limits.js";
import { modelAccessErrorKindSchema } from "./model-access.js";

/**
 * Thread events that the agent causes. The supervisor translates the agent
 * harness's own events into these, so nothing outside the supervisor depends
 * on the harness. Every one of them is recorded in the thread's sequence.
 */

const errorMessageSchema = z.string().min(1).max(maximumErrorMessageLength);

/**
 * The agent started working on input after being idle. The run ends with
 * exactly one `agent_run_settled`, or with `agent_failed` if the harness
 * breaks first. A harness may retry or continue internally; the supervisor
 * reports all of that as this one run.
 */
export const agentRunStartedEventSchema = z.strictObject({
  type: z.literal("agent_run_started"),
});

/**
 * Why the model stopped producing an assistant message. `"errored"` is how
 * model provider failures, such as a rejected key or an exhausted quota,
 * reach the user; `"interrupted"` means the user interrupted the agent.
 */
export const assistantMessageEndReasonSchema = z.enum([
  "completed",
  "tool_use_requested",
  "length_limit_reached",
  "errored",
  "interrupted",
]);

/**
 * A complete assistant message. It is the authoritative record of what the
 * model said and supersedes any stream fragments sent while it was produced.
 *
 * An errored message carries the provider's own `errorMessage` and, when the
 * harness recognised the failure as one the user can act on, its
 * `errorKind` (see `modelAccessErrorKindSchema`); clients explain the kind,
 * and never read meaning into the message's wording.
 */
export const assistantMessageEventSchema = z
  .strictObject({
    type: z.literal("assistant_message"),
    messageId: identifierSchema,
    content: z.array(assistantContentBlockSchema),
    endReason: assistantMessageEndReasonSchema,
    errorMessage: errorMessageSchema.exactOptional(),
    errorKind: modelAccessErrorKindSchema.exactOptional(),
  })
  .refine((event) => (event.endReason === "errored") === (event.errorMessage !== undefined), {
    message: 'errorMessage is required when endReason is "errored" and not allowed otherwise',
    path: ["errorMessage"],
  })
  .refine((event) => event.errorKind === undefined || event.endReason === "errored", {
    message: 'errorKind is allowed only when endReason is "errored"',
    path: ["errorKind"],
  });

export const toolExecutionStartedEventSchema = z.strictObject({
  type: z.literal("tool_execution_started"),
  toolCallId: identifierSchema,
  toolName: toolNameSchema,
  arguments: toolArgumentsSchema,
});

/**
 * What a tool produced, as text. The supervisor truncates long output to
 * `maximumToolOutputLength` to keep stored history small, and records the
 * size of the full output so the user can see that something was cut.
 */
export const toolOutputSchema = z.strictObject({
  text: z.string().max(maximumToolOutputLength),
  isTruncated: z.boolean(),
  originalSizeInBytes: z.int().nonnegative(),
});

export const toolExecutionFinishedEventSchema = z.strictObject({
  type: z.literal("tool_execution_finished"),
  toolCallId: identifierSchema,
  toolName: toolNameSchema,
  isError: z.boolean(),
  output: toolOutputSchema,
  durationInMilliseconds: z.int().nonnegative().exactOptional(),
});

/**
 * The agent has finished and has nothing queued: it will not continue until
 * it receives new input. This is the only event that means so; a thread's
 * status must key off it rather than off the end of any single message.
 */
export const agentRunSettledEventSchema = z.strictObject({
  type: z.literal("agent_run_settled"),
  wasInterrupted: z.boolean(),
});

/**
 * The agent harness itself broke: its process would not start or exited
 * unexpectedly. Model provider failures are not reported this way; they end
 * an assistant message with `endReason: "errored"`.
 *
 * The control plane records one too, in place of the agent, to close a run
 * that can no longer end: one whose supervisor was replaced by a new
 * supervisor process (the sandbox or its supervisor restarted) before the
 * run's end was recorded. Its `errorMessage` then says so.
 */
export const agentFailedEventSchema = z.strictObject({
  type: z.literal("agent_failed"),
  errorMessage: errorMessageSchema,
});

export const agentEventSchema = z.discriminatedUnion("type", [
  agentRunStartedEventSchema,
  assistantMessageEventSchema,
  toolExecutionStartedEventSchema,
  toolExecutionFinishedEventSchema,
  agentRunSettledEventSchema,
  agentFailedEventSchema,
]);

export type AgentRunStartedEvent = z.infer<typeof agentRunStartedEventSchema>;
export type AssistantMessageEndReason = z.infer<typeof assistantMessageEndReasonSchema>;
export type AssistantMessageEvent = z.infer<typeof assistantMessageEventSchema>;
export type ToolExecutionStartedEvent = z.infer<typeof toolExecutionStartedEventSchema>;
export type ToolOutput = z.infer<typeof toolOutputSchema>;
export type ToolExecutionFinishedEvent = z.infer<typeof toolExecutionFinishedEventSchema>;
export type AgentRunSettledEvent = z.infer<typeof agentRunSettledEventSchema>;
export type AgentFailedEvent = z.infer<typeof agentFailedEventSchema>;
export type AgentEvent = z.infer<typeof agentEventSchema>;
