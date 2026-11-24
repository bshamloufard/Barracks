import { StringDecoder } from "node:string_decoder";
import type { ProviderApiFormat } from "@barrack/model-catalogue";
import { z } from "zod";

/**
 * Reads, from an answer passing through the proxy, what the provider says
 * it used: as it streams by, without holding it up. Each format reports
 * usage its own way (checked against each provider's API reference):
 *
 * - Anthropic Messages: `message_start` carries the model and the input
 *   (with cache reads and writes, which `input_tokens` excludes);
 *   `message_delta` carries cumulative counts, the output at least; a
 *   non-streamed answer has `usage` at the top.
 *   https://docs.anthropic.com/en/docs/build-with-claude/streaming
 * - OpenAI Responses: `response.completed` (or `.incomplete`, `.failed`)
 *   carries `response.usage`, whose `input_tokens` include the cached
 *   ones (`input_tokens_details.cached_tokens`, and `cache_write_tokens`
 *   where reported, as the agent itself reads it).
 *   https://platform.openai.com/docs/api-reference/responses-streaming
 * - OpenAI Chat Completions: the last chunk carries `usage` when the request
 *   asked for it (`stream_options.include_usage`, which the proxy sets on
 *   every streamed request), whose `prompt_tokens` include the cached ones.
 *   https://platform.openai.com/docs/api-reference/chat-streaming
 *
 * Counts are kept apart so they never overlap: input excludes what was read
 * from or written to the prompt cache. Alongside, the meter counts the
 * characters of text and tool arguments generated, so that an answer cut
 * off before its usage arrived can still be estimated.
 */
export type MeteredUsage = {
  /** The model the provider says answered, when it says. */
  modelId: string | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Whether the provider reported its final usage, as it does at the end of an answer. */
  isFinal: boolean;
  /** Characters of text, thinking and tool arguments seen generated. */
  generatedCharacters: number;
  /**
   * Whether the answer showed reasoning begin (a thinking block, a
   * reasoning item, reasoning text), whose tokens may not all be shown.
   */
  sawReasoning: boolean;
};

/** An event longer than this without an end is not read (the answer still passes through). */
const maximumEventLength = 1024 * 1024;

/** A non-streamed answer longer than this is not read for usage, only estimated. */
const maximumJsonAnswerLength = 8 * 1024 * 1024;

export class UsageMeter {
  readonly #format: ProviderApiFormat;
  readonly #isEventStream: boolean;
  readonly #decoder = new StringDecoder("utf8");
  #pending = "";
  #isUnreadable = false;
  #unreadCharacters = 0;
  readonly #usage: MeteredUsage = {
    modelId: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    isFinal: false,
    generatedCharacters: 0,
    sawReasoning: false,
  };

  constructor(format: ProviderApiFormat, contentType: string | undefined) {
    this.#format = format;
    this.#isEventStream = contentType?.toLowerCase().includes("text/event-stream") ?? false;
  }

  write(chunk: Buffer): void {
    const text = this.#decoder.write(chunk);
    if (this.#isUnreadable) {
      this.#unreadCharacters += text.length;
      return;
    }
    this.#pending += text;
    if (this.#isEventStream) {
      this.#readCompleteEvents();
    } else if (this.#pending.length > maximumJsonAnswerLength) {
      this.#giveUpReading();
    }
  }

  /** What was read; call once the answer has ended, completely or not. */
  finish(): MeteredUsage {
    const rest = this.#pending + this.#decoder.end();
    this.#pending = "";
    if (this.#isUnreadable) {
      this.#unreadCharacters += rest.length;
    } else if (this.#isEventStream) {
      this.#readEvent(rest);
    } else {
      this.#readJsonAnswer(rest);
    }
    // Text that could not be read is mostly the answer's own words, in markup.
    this.#usage.generatedCharacters += Math.ceil(this.#unreadCharacters / 2);
    return { ...this.#usage };
  }

  #readCompleteEvents(): void {
    for (
      let end = findEventEnd(this.#pending);
      end !== undefined;
      end = findEventEnd(this.#pending)
    ) {
      this.#readEvent(this.#pending.slice(0, end.index));
      this.#pending = this.#pending.slice(end.index + end.length);
    }
    if (this.#pending.length > maximumEventLength) {
      this.#giveUpReading();
    }
  }

  #giveUpReading(): void {
    this.#isUnreadable = true;
    this.#unreadCharacters += this.#pending.length;
    this.#pending = "";
  }

  /** One server-sent event: its `data:` lines joined, as the format defines. */
  #readEvent(eventText: string): void {
    const data = eventText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n");
    this.#readPayload(parseJsonObject(data));
  }

  #readJsonAnswer(text: string): void {
    this.#readPayload(parseJsonObject(text));
  }

  #readPayload(payload: unknown): void {
    switch (this.#format) {
      case "anthropic_messages":
        readAnthropicPayload(payload, this.#usage);
        return;
      case "openai_responses":
        readResponsesPayload(payload, this.#usage);
        return;
      case "openai_chat_completions":
        readChatCompletionsPayload(payload, this.#usage);
        return;
    }
  }
}

/** A token count as a provider reports it; anything else is ignored. */
const countSchema = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().catch(undefined);
const textSchema = z.string().optional().catch(undefined);
const modelSchema = z.string().min(1).optional().catch(undefined);

const anthropicUsageSchema = z
  .object({
    input_tokens: countSchema,
    output_tokens: countSchema,
    cache_read_input_tokens: countSchema,
    cache_creation_input_tokens: countSchema,
  })
  .optional()
  .catch(undefined);

const anthropicPayloadSchema = z.object({
  type: textSchema,
  model: modelSchema,
  usage: anthropicUsageSchema,
  message: z
    .object({ model: modelSchema, usage: anthropicUsageSchema })
    .optional()
    .catch(undefined),
  delta: z
    .object({
      type: textSchema,
      text: textSchema,
      partial_json: textSchema,
      thinking: textSchema,
    })
    .optional()
    .catch(undefined),
  content_block: z.object({ type: textSchema }).optional().catch(undefined),
});

/** Anthropic's content blocks, and their deltas, that carry reasoning, shown or not. */
const anthropicReasoningTypes = new Set([
  "thinking",
  "redacted_thinking",
  "thinking_delta",
  "signature_delta",
]);

type AnthropicUsage = z.infer<typeof anthropicUsageSchema>;

function readAnthropicPayload(value: unknown, usage: MeteredUsage): void {
  const parsed = anthropicPayloadSchema.safeParse(value);
  if (!parsed.success) {
    return;
  }
  const payload = parsed.data;
  switch (payload.type) {
    case "message_start":
      usage.modelId = payload.message?.model ?? usage.modelId;
      readAnthropicUsage(payload.message?.usage, usage);
      return;
    case "message_delta":
      readAnthropicUsage(payload.usage, usage);
      usage.isFinal = usage.inputTokens !== undefined && usage.outputTokens !== undefined;
      return;
    case "content_block_start":
      usage.sawReasoning ||= anthropicReasoningTypes.has(payload.content_block?.type ?? "");
      return;
    case "content_block_delta":
      usage.sawReasoning ||= anthropicReasoningTypes.has(payload.delta?.type ?? "");
      usage.generatedCharacters += lengthOf(
        payload.delta?.text,
        payload.delta?.partial_json,
        payload.delta?.thinking,
      );
      return;
    case "message":
      usage.modelId = payload.model ?? usage.modelId;
      readAnthropicUsage(payload.usage, usage);
      usage.isFinal = usage.inputTokens !== undefined && usage.outputTokens !== undefined;
      return;
  }
}

/** Counts in `message_delta` are cumulative, so each replaces what came before. */
function readAnthropicUsage(reported: AnthropicUsage, usage: MeteredUsage): void {
  if (reported === undefined) {
    return;
  }
  usage.inputTokens = reported.input_tokens ?? usage.inputTokens;
  usage.outputTokens = reported.output_tokens ?? usage.outputTokens;
  usage.cacheReadTokens = reported.cache_read_input_tokens ?? usage.cacheReadTokens;
  usage.cacheWriteTokens = reported.cache_creation_input_tokens ?? usage.cacheWriteTokens;
}

const openAiResponseSchema = z.object({
  model: modelSchema,
  usage: z
    .object({
      input_tokens: countSchema,
      output_tokens: countSchema,
      input_tokens_details: z
        .object({ cached_tokens: countSchema, cache_write_tokens: countSchema })
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
});

const responsesPayloadSchema = openAiResponseSchema.extend({
  type: textSchema,
  delta: textSchema,
  response: openAiResponseSchema.optional().catch(undefined),
  item: z.object({ type: textSchema }).optional().catch(undefined),
});

const finalResponseEvents = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

function readResponsesPayload(value: unknown, usage: MeteredUsage): void {
  const parsed = responsesPayloadSchema.safeParse(value);
  if (!parsed.success) {
    return;
  }
  const payload = parsed.data;
  // A reasoning item is added when reasoning begins, whether or not its
  // summary is asked for; its text, if any, comes in `response.reasoning_*`.
  usage.sawReasoning ||=
    (payload.type === "response.output_item.added" && payload.item?.type === "reasoning") ||
    (payload.type?.startsWith("response.reasoning") ?? false);
  if (payload.type?.endsWith(".delta")) {
    usage.generatedCharacters += lengthOf(payload.delta);
    return;
  }
  // A streamed event wraps the response; a non-streamed answer is one.
  const isStreamed = payload.type?.startsWith("response.") ?? false;
  const response = isStreamed ? payload.response : payload;
  usage.modelId = response?.model ?? usage.modelId;
  const reported = response?.usage;
  const isFinal = !isStreamed || finalResponseEvents.has(payload.type ?? "");
  if (reported === undefined || !isFinal) {
    return;
  }
  readInputIncludingCache(
    reported.input_tokens,
    reported.input_tokens_details?.cached_tokens,
    usage,
    reported.input_tokens_details?.cache_write_tokens,
  );
  usage.outputTokens = reported.output_tokens;
  usage.isFinal = usage.inputTokens !== undefined && usage.outputTokens !== undefined;
}

const chatDeltaSchema = z
  .object({
    content: textSchema,
    reasoning_content: textSchema,
    reasoning: textSchema,
    reasoning_details: z.array(z.unknown()).optional().catch(undefined),
    tool_calls: z
      .array(
        z.object({ function: z.object({ arguments: textSchema }).optional().catch(undefined) }),
      )
      .optional()
      .catch(undefined),
  })
  .optional()
  .catch(undefined);

const chatCompletionsPayloadSchema = z.object({
  model: modelSchema,
  choices: z
    .array(z.object({ delta: chatDeltaSchema, message: chatDeltaSchema }))
    .optional()
    .catch(undefined),
  usage: z
    .object({
      prompt_tokens: countSchema,
      completion_tokens: countSchema,
      prompt_tokens_details: z.object({ cached_tokens: countSchema }).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

function readChatCompletionsPayload(value: unknown, usage: MeteredUsage): void {
  const parsed = chatCompletionsPayloadSchema.safeParse(value);
  if (!parsed.success) {
    return;
  }
  const payload = parsed.data;
  usage.modelId = payload.model ?? usage.modelId;
  for (const choice of payload.choices ?? []) {
    const delta = choice.delta ?? choice.message;
    usage.sawReasoning ||=
      lengthOf(delta?.reasoning_content, delta?.reasoning) > 0 ||
      (delta?.reasoning_details?.length ?? 0) > 0;
    usage.generatedCharacters += lengthOf(
      delta?.content,
      delta?.reasoning_content,
      delta?.reasoning,
    );
    for (const call of delta?.tool_calls ?? []) {
      usage.generatedCharacters += lengthOf(call.function?.arguments);
    }
  }
  const reported = payload.usage;
  if (reported === undefined) {
    return;
  }
  readInputIncludingCache(
    reported.prompt_tokens,
    reported.prompt_tokens_details?.cached_tokens,
    usage,
  );
  usage.outputTokens = reported.completion_tokens;
  usage.isFinal = usage.inputTokens !== undefined && usage.outputTokens !== undefined;
}

/**
 * OpenAI's input counts include the tokens read from (and, where reported,
 * written to) the prompt cache; Barrack's never overlap.
 */
function readInputIncludingCache(
  inputTokens: number | undefined,
  cachedTokens: number | undefined,
  usage: MeteredUsage,
  cacheWriteTokens = 0,
): void {
  const cached = cachedTokens ?? 0;
  usage.inputTokens =
    inputTokens === undefined ? undefined : Math.max(0, inputTokens - cached - cacheWriteTokens);
  usage.cacheReadTokens = cached;
  usage.cacheWriteTokens = cacheWriteTokens;
}

function findEventEnd(text: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(text);
  return match === null ? undefined : { index: match.index, length: match[0].length };
}

/** The parsed JSON of an object, or undefined for anything else (such as `[DONE]`). */
function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function lengthOf(...values: Array<string | undefined>): number {
  return values.reduce<number>((total, value) => total + (value?.length ?? 0), 0);
}
