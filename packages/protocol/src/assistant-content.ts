import { z } from "zod";
import { identifierSchema } from "./identifier.js";
import { maximumToolNameLength } from "./limits.js";

export const toolNameSchema = z.string().min(1).max(maximumToolNameLength);

/** The arguments the model chose for a tool call, as a JSON object. */
export const toolArgumentsSchema = z.record(z.string(), z.json());

export const textContentBlockSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
});

/** The model's visible reasoning, for models that expose it. */
export const thinkingContentBlockSchema = z.strictObject({
  type: z.literal("thinking"),
  text: z.string(),
});

/** A request by the model to run a tool. Its execution is reported by separate thread events. */
export const toolCallContentBlockSchema = z.strictObject({
  type: z.literal("tool_call"),
  toolCallId: identifierSchema,
  toolName: toolNameSchema,
  arguments: toolArgumentsSchema,
});

export const assistantContentBlockSchema = z.discriminatedUnion("type", [
  textContentBlockSchema,
  thinkingContentBlockSchema,
  toolCallContentBlockSchema,
]);

export type ToolArguments = z.infer<typeof toolArgumentsSchema>;
export type TextContentBlock = z.infer<typeof textContentBlockSchema>;
export type ThinkingContentBlock = z.infer<typeof thinkingContentBlockSchema>;
export type ToolCallContentBlock = z.infer<typeof toolCallContentBlockSchema>;
export type AssistantContentBlock = z.infer<typeof assistantContentBlockSchema>;
