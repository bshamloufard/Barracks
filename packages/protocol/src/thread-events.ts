import { z } from "zod";
import { agentEventSchema } from "./agent-events.js";
import { identifierSchema } from "./identifier.js";
import { maximumUserMessageLength } from "./limits.js";
import { repositoryEventSchema } from "./repository-events.js";
import { sequenceSchema } from "./sequence.js";

export const userMessageTextSchema = z.string().min(1).max(maximumUserMessageLength);

/**
 * A message the user sent to the agent. The control plane records it as soon
 * as it accepts the user's input, rather than waiting for the agent to echo
 * it back, so the user's own words are never lost when the agent is not
 * running. This is the one thread event an agent cannot emit.
 */
export const userMessageEventSchema = z.strictObject({
  type: z.literal("user_message"),
  messageId: identifierSchema,
  text: userMessageTextSchema,
});

/** Everything that can appear in a thread's history. */
export const threadEventSchema = z.discriminatedUnion("type", [
  userMessageEventSchema,
  ...agentEventSchema.options,
  ...repositoryEventSchema.options,
]);

/** A thread event as the control plane stored it, with its place in the thread. */
export const recordedThreadEventSchema = z.strictObject({
  sequence: sequenceSchema,
  /** ISO 8601 in UTC, as produced by `Date.prototype.toISOString`. */
  recordedAt: z.iso.datetime(),
  event: threadEventSchema,
});

export type UserMessageEvent = z.infer<typeof userMessageEventSchema>;
export type ThreadEvent = z.infer<typeof threadEventSchema>;
export type RecordedThreadEvent = z.infer<typeof recordedThreadEventSchema>;
