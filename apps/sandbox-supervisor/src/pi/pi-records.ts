import type { ParseResult } from "@barrack/protocol";
import { z } from "zod";

/**
 * What Pi writes to stdout, checked before anything trusts it. Only the
 * fields the supervisor reads are described. Pi ships every week, so extra
 * fields are allowed everywhere and unknown record types are reported as
 * unrecognized rather than rejected.
 * Reference for every shape here, pinned to the version in package.json:
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
 */

/**
 * A fallback member for a union of content blocks: it matches any block whose
 * `type` is not one of the known ones, and becomes `{ unrecognized: <type> }`
 * so code can tell it apart from the known blocks. A known block with a bad
 * shape still fails validation instead of quietly passing as unrecognized.
 */
function unrecognizedBlockSchema(knownTypes: readonly string[]) {
  return z
    .looseObject({ type: z.string().refine((type) => !knownTypes.includes(type)) })
    .transform((block) => ({ unrecognized: block.type }));
}

const textBlockSchema = z.looseObject({ type: z.literal("text"), text: z.string() });
const thinkingBlockSchema = z.looseObject({ type: z.literal("thinking"), thinking: z.string() });
const toolCallBlockSchema = z.looseObject({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.json()),
});
const imageBlockSchema = z.looseObject({ type: z.literal("image"), mimeType: z.string() });

const assistantContentBlockSchema = z.union([
  textBlockSchema,
  thinkingBlockSchema,
  toolCallBlockSchema,
  unrecognizedBlockSchema(["text", "thinking", "toolCall"]),
]);

const assistantMessageSchema = z.looseObject({
  role: z.literal("assistant"),
  content: z.array(assistantContentBlockSchema),
  stopReason: z.string(),
  errorMessage: z.string().optional(),
});

/** User, system, tool result and extension messages: the supervisor forwards none of them. */
const otherMessageSchema = z
  .looseObject({ role: z.string().refine((role) => role !== "assistant") })
  .transform((message) => ({ otherRole: message.role }));

const messageSchema = z.union([assistantMessageSchema, otherMessageSchema]);

const toolResultContentBlockSchema = z.union([
  textBlockSchema,
  imageBlockSchema,
  unrecognizedBlockSchema(["text", "image"]),
]);

const eventSchemas = {
  agent_start: z.looseObject({ type: z.literal("agent_start") }),
  agent_settled: z.looseObject({ type: z.literal("agent_settled"), aborted: z.boolean() }),
  message_start: z.looseObject({ type: z.literal("message_start"), message: messageSchema }),
  message_update: z.looseObject({
    type: z.literal("message_update"),
    assistantMessageEvent: z.looseObject({
      type: z.string(),
      contentIndex: z.int().nonnegative().optional(),
      delta: z.string().optional(),
    }),
  }),
  message_end: z.looseObject({ type: z.literal("message_end"), message: messageSchema }),
  tool_execution_start: z.looseObject({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.record(z.string(), z.json()),
  }),
  tool_execution_end: z.looseObject({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    toolName: z.string(),
    result: z.looseObject({ content: z.array(toolResultContentBlockSchema) }),
    isError: z.boolean(),
    durationMs: z.number().nonnegative().optional(),
  }),
} as const;

const responseSchema = z.looseObject({
  type: z.literal("response"),
  id: z.string().optional(),
  command: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  data: z.unknown().optional(),
});

/**
 * An extension asking the user something. Dialog methods block Pi until they
 * are answered.
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md
 */
const extensionUiRequestSchema = z.looseObject({
  type: z.literal("extension_ui_request"),
  id: z.string(),
  method: z.string(),
});

/**
 * The `data` of Pi's answer to `get_state`. `sessionFile` is absent when Pi
 * runs without a session.
 */
const stateSchema = z.looseObject({ sessionFile: z.string().optional() });

export type PiState = z.infer<typeof stateSchema>;

export function parsePiState(responseData: unknown): ParseResult<PiState> {
  return validate(stateSchema, responseData, (state) => state);
}

export type PiAssistantMessage = z.infer<typeof assistantMessageSchema>;
export type PiMessage = z.infer<typeof messageSchema>;
export type PiAssistantContentBlock = z.infer<typeof assistantContentBlockSchema>;
export type PiToolResultContentBlock = z.infer<typeof toolResultContentBlockSchema>;
export type PiEvent = {
  [Type in keyof typeof eventSchemas]: z.infer<(typeof eventSchemas)[Type]>;
}[keyof typeof eventSchemas];
export type PiResponse = z.infer<typeof responseSchema>;
export type PiExtensionUiRequest = z.infer<typeof extensionUiRequestSchema>;

export type PiRecord =
  | { kind: "response"; response: PiResponse }
  | { kind: "event"; event: PiEvent }
  | { kind: "extension_ui_request"; request: PiExtensionUiRequest }
  | { kind: "unrecognized"; type: string };

const recordTypeSchema = z.looseObject({ type: z.string() });

export function parsePiRecord(line: string): ParseResult<PiRecord> {
  const decoded = decodeJson(line);
  if (!decoded.ok) {
    return decoded;
  }
  const typed = recordTypeSchema.safeParse(decoded.value);
  if (!typed.success) {
    return { ok: false, errorMessage: "Record has no string `type` field." };
  }
  return parseTypedRecord(typed.data.type, decoded.value);
}

function parseTypedRecord(type: string, record: unknown): ParseResult<PiRecord> {
  if (type === "response") {
    return validate(responseSchema, record, (response) => ({ kind: "response", response }));
  }
  if (type === "extension_ui_request") {
    return validate(extensionUiRequestSchema, record, (request) => ({
      kind: "extension_ui_request",
      request,
    }));
  }
  if (isKnownEventType(type)) {
    return validate(eventSchemas[type], record, (event: PiEvent) => ({ kind: "event", event }));
  }
  return { ok: true, value: { kind: "unrecognized", type } };
}

function isKnownEventType(type: string): type is keyof typeof eventSchemas {
  return Object.hasOwn(eventSchemas, type);
}

function validate<Parsed, Wrapped>(
  schema: z.ZodType<Parsed>,
  value: unknown,
  wrap: (parsed: Parsed) => Wrapped,
): ParseResult<Wrapped> {
  const validation = schema.safeParse(value);
  if (!validation.success) {
    return { ok: false, errorMessage: z.prettifyError(validation.error) };
  }
  return { ok: true, value: wrap(validation.data) };
}

function decodeJson(line: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, errorMessage: `Line is not valid JSON: ${reason}` };
  }
}
