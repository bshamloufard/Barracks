import { z } from "zod";
import { identifierSchema } from "./identifier.js";

/**
 * Stream fragments let a viewer watch the agent's output appear while it is
 * produced. They are relayed live and never stored or sequenced, so any of
 * them may be lost (for example while a client reconnects). Nothing may
 * depend on receiving them: the thread event they lead up to is the record.
 */

/**
 * Text to append to one content block of an assistant message that is still
 * being produced. The `assistant_message` thread event with the same
 * `messageId` replaces everything assembled from these fragments.
 */
export const assistantTextFragmentSchema = z.strictObject({
  type: z.literal("assistant_text_fragment"),
  messageId: identifierSchema,
  contentBlockIndex: z.int().nonnegative(),
  contentBlockType: z.enum(["text", "thinking"]),
  appendedText: z.string(),
});

export const streamFragmentSchema = z.discriminatedUnion("type", [assistantTextFragmentSchema]);

/** Carries a stream fragment on both hops: supervisor to control plane, and control plane to client. */
export const streamFragmentMessageSchema = z.strictObject({
  type: z.literal("stream_fragment"),
  fragment: streamFragmentSchema,
});

export type AssistantTextFragment = z.infer<typeof assistantTextFragmentSchema>;
export type StreamFragment = z.infer<typeof streamFragmentSchema>;
export type StreamFragmentMessage = z.infer<typeof streamFragmentMessageSchema>;
