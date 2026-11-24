import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The three provider APIs the mock speaks, each as its owner documents it,
 * so the real agent's own clients, and the control plane's model proxy in
 * between, see what they would see from the provider:
 *
 * - OpenAI's Chat Completions, streamed as chunks, with the usage in a last
 *   chunk when the request asks for it (`stream_options.include_usage`):
 *   https://platform.openai.com/docs/api-reference/chat-streaming
 * - Anthropic's Messages, streamed as `message_start`, content blocks,
 *   `message_delta` (with the cumulative output count) and `message_stop`;
 *   errors as `{ type: "error", error: { type, message } }`:
 *   https://docs.anthropic.com/en/docs/build-with-claude/streaming
 *   https://docs.anthropic.com/en/api/errors
 * - OpenAI's Responses, streamed as `response.*` events ending in
 *   `response.completed` with the usage:
 *   https://platform.openai.com/docs/api-reference/responses-streaming
 *
 * OpenAI's errors are `{ error: { message, type, code } }`:
 * https://platform.openai.com/docs/guides/error-codes
 */
export type WireFormat = "chat_completions" | "anthropic_messages" | "openai_responses";

/** A message of the conversation, whatever the format: tool results have the role `tool`. */
export type ChatMessage = { role: string; content: unknown };

/** What an answer used, as Barrack counts it: input never includes the cached tokens. */
export type MockUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ToolCall = {
  text: string;
  toolName: string;
  toolArguments: object;
  toolCallId: string;
};

/** Writes one streamed answer in a format; `finish` ends it with its usage. */
export type ReplyWriter = {
  /** How many pieces were streamed, which the reported output count is built from. */
  readonly outputPieces: number;
  writeText(text: string): void;
  writeToolCall(call: ToolCall): void;
  finish(endReason: "stop" | "tool_use"): void;
  hasClientLeft(): boolean;
};

export type MockFailureKind =
  | "overloaded"
  | "invalid_key"
  | "exhausted_quota"
  | "rate_limit"
  | "context_overflow";

export function wireFormatOf(url: string | undefined): WireFormat | undefined {
  const path = url?.split("?", 1)[0] ?? "";
  if (path.endsWith("/chat/completions")) {
    return "chat_completions";
  }
  if (path.endsWith("/v1/messages")) {
    return "anthropic_messages";
  }
  if (path.endsWith("/responses")) {
    return "openai_responses";
  }
  return undefined;
}

/** The request's key: Anthropic's clients send `x-api-key`, OpenAI's a bearer token. */
export function readCredential(request: IncomingMessage): string | undefined {
  const apiKey = request.headers["x-api-key"];
  if (typeof apiKey === "string") {
    return apiKey;
  }
  const { authorization } = request.headers;
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
}

type RequestBody = {
  model: string;
  messages?: Array<{ role: string; content: unknown }>;
  input?: Array<{ role?: string; type?: string; content?: unknown; output?: unknown }>;
};

/** The conversation, as one list of messages whatever the format. */
export function readConversation(format: WireFormat, body: RequestBody): ChatMessage[] {
  switch (format) {
    case "chat_completions":
      return body.messages ?? [];
    case "anthropic_messages":
      return (body.messages ?? []).map((message) =>
        isAnthropicToolResult(message.content)
          ? { role: "tool", content: message.content }
          : message,
      );
    case "openai_responses":
      return (body.input ?? []).map((item) => {
        if (item.type === "function_call_output") {
          return { role: "tool", content: item.output };
        }
        if (item.type === "function_call") {
          return { role: "assistant", content: item };
        }
        return { role: item.role ?? item.type ?? "unknown", content: item.content };
      });
  }
}

function isAnthropicToolResult(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (part: unknown) =>
        typeof part === "object" && part !== null && "type" in part && part.type === "tool_result",
    )
  );
}

/** Deterministic, so a test can compare what the proxy measured with what the mock said. */
export function describeUsage(
  format: WireFormat,
  conversation: ChatMessage[],
  outputPieces: number,
): MockUsage {
  const cacheReadTokens = format === "anthropic_messages" ? 7 : 3;
  return {
    inputTokens: Math.ceil(JSON.stringify(conversation).length / 4) + 10,
    outputTokens: outputPieces + 1,
    cacheReadTokens,
    cacheWriteTokens: format === "anthropic_messages" ? 5 : 0,
  };
}

const openAiFailures: Record<MockFailureKind, { status: number; error: object }> = {
  overloaded: { status: 503, error: { message: "The model is overloaded." } },
  invalid_key: {
    status: 401,
    error: {
      message: "Incorrect API key provided",
      type: "invalid_request_error",
      code: "invalid_api_key",
    },
  },
  exhausted_quota: {
    status: 429,
    error: {
      message: "You exceeded your current quota, please check your plan and billing details.",
      type: "insufficient_quota",
      code: "insufficient_quota",
    },
  },
  rate_limit: {
    status: 429,
    error: {
      message: "Rate limit reached for requests",
      type: "requests",
      code: "rate_limit_exceeded",
    },
  },
  context_overflow: {
    status: 400,
    error: { message: "Your input exceeds the context window of this model." },
  },
};

/** Anthropic's statuses and types, from its errors page; the credit message as it documents it. */
const anthropicFailures: Record<
  MockFailureKind,
  { status: number; type: string; message: string }
> = {
  overloaded: { status: 529, type: "overloaded_error", message: "Overloaded" },
  invalid_key: { status: 401, type: "authentication_error", message: "invalid x-api-key" },
  exhausted_quota: {
    status: 400,
    type: "invalid_request_error",
    message:
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
  rate_limit: {
    status: 429,
    type: "rate_limit_error",
    message: "Number of request tokens has exceeded your per-minute rate limit",
  },
  context_overflow: {
    status: 400,
    type: "invalid_request_error",
    message: "prompt is too long: 250000 tokens > 200000 maximum",
  },
};

export function writeFailure(
  response: ServerResponse,
  format: WireFormat,
  kind: MockFailureKind,
): void {
  response.setHeader("content-type", "application/json");
  if (format === "anthropic_messages") {
    const failure = anthropicFailures[kind];
    response.writeHead(failure.status);
    response.end(
      JSON.stringify({ type: "error", error: { type: failure.type, message: failure.message } }),
    );
    return;
  }
  const failure = openAiFailures[kind];
  response.writeHead(failure.status);
  response.end(JSON.stringify({ error: failure.error }));
}

export function createReplyWriter(
  format: WireFormat,
  response: ServerResponse,
  model: string,
  usage: (outputPieces: number) => MockUsage,
): ReplyWriter {
  response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_mock" });
  switch (format) {
    case "chat_completions":
      return new ChatCompletionsReply(response, model, usage);
    case "anthropic_messages":
      return new AnthropicReply(response, model, usage);
    case "openai_responses":
      return new ResponsesReply(response, model, usage);
  }
}

abstract class StreamedReply implements ReplyWriter {
  protected readonly response: ServerResponse;
  protected readonly model: string;
  protected readonly usage: (outputPieces: number) => MockUsage;
  outputPieces = 0;

  constructor(response: ServerResponse, model: string, usage: (outputPieces: number) => MockUsage) {
    this.response = response;
    this.model = model;
    this.usage = usage;
  }

  hasClientLeft(): boolean {
    return this.response.destroyed;
  }

  protected send(data: object, eventName?: string): void {
    const eventLine = eventName === undefined ? "" : `event: ${eventName}\n`;
    this.response.write(`${eventLine}data: ${JSON.stringify(data)}\n\n`);
  }

  abstract writeText(text: string): void;
  abstract writeToolCall(call: ToolCall): void;
  abstract finish(endReason: "stop" | "tool_use"): void;
}

class ChatCompletionsReply extends StreamedReply {
  #hasStarted = false;

  writeText(text: string): void {
    this.outputPieces += 1;
    this.#chunk({ ...this.#role(), content: text }, null);
  }

  writeToolCall(call: ToolCall): void {
    this.outputPieces += 2;
    this.#chunk({ ...this.#role(), content: call.text }, null);
    this.#chunk(
      {
        tool_calls: [
          {
            index: 0,
            id: call.toolCallId,
            type: "function",
            function: { name: call.toolName, arguments: "" },
          },
        ],
      },
      null,
    );
    this.#chunk(
      { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(call.toolArguments) } }] },
      null,
    );
  }

  finish(endReason: "stop" | "tool_use"): void {
    this.#chunk({}, endReason === "stop" ? "stop" : "tool_calls");
    const usage = this.usage(this.outputPieces);
    this.send({
      id: "mock-completion",
      object: "chat.completion.chunk",
      created: 0,
      model: this.model,
      choices: [],
      usage: {
        prompt_tokens: usage.inputTokens + usage.cacheReadTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.cacheReadTokens + usage.outputTokens,
        prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
      },
    });
    this.response.end("data: [DONE]\n\n");
  }

  #role(): { role?: string } {
    if (this.#hasStarted) {
      return {};
    }
    this.#hasStarted = true;
    return { role: "assistant" };
  }

  #chunk(delta: object, finishReason: string | null): void {
    this.send({
      id: "mock-completion",
      object: "chat.completion.chunk",
      created: 0,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
  }
}

class AnthropicReply extends StreamedReply {
  #blockIndex = 0;

  constructor(response: ServerResponse, model: string, usage: (outputPieces: number) => MockUsage) {
    super(response, model, usage);
    const startingUsage = usage(0);
    this.send(
      {
        type: "message_start",
        message: {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: startingUsage.inputTokens,
            cache_creation_input_tokens: startingUsage.cacheWriteTokens,
            cache_read_input_tokens: startingUsage.cacheReadTokens,
            output_tokens: 1,
          },
        },
      },
      "message_start",
    );
  }

  writeText(text: string): void {
    this.outputPieces += 1;
    const index = this.#blockIndex;
    this.#blockIndex += 1;
    this.send(
      { type: "content_block_start", index, content_block: { type: "text", text: "" } },
      "content_block_start",
    );
    this.send(
      { type: "content_block_delta", index, delta: { type: "text_delta", text } },
      "content_block_delta",
    );
    this.send({ type: "content_block_stop", index }, "content_block_stop");
  }

  writeToolCall(call: ToolCall): void {
    this.writeText(call.text);
    this.outputPieces += 1;
    const index = this.#blockIndex;
    this.#blockIndex += 1;
    this.send(
      {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: call.toolCallId, name: call.toolName, input: {} },
      },
      "content_block_start",
    );
    this.send(
      {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.toolArguments) },
      },
      "content_block_delta",
    );
    this.send({ type: "content_block_stop", index }, "content_block_stop");
  }

  finish(endReason: "stop" | "tool_use"): void {
    const usage = this.usage(this.outputPieces);
    this.send(
      {
        type: "message_delta",
        delta: { stop_reason: endReason === "stop" ? "end_turn" : "tool_use", stop_sequence: null },
        usage: { output_tokens: usage.outputTokens },
      },
      "message_delta",
    );
    this.send({ type: "message_stop" }, "message_stop");
    this.response.end();
  }
}

class ResponsesReply extends StreamedReply {
  readonly #output: object[] = [];
  #sequence = 0;

  constructor(response: ServerResponse, model: string, usage: (outputPieces: number) => MockUsage) {
    super(response, model, usage);
    this.#event("response.created", { response: this.#response("in_progress", null) });
  }

  writeText(text: string): void {
    this.outputPieces += 1;
    const outputIndex = this.#output.length;
    const itemId = `msg_${outputIndex}`;
    const part = { type: "output_text", text, annotations: [] };
    this.#event("response.output_item.added", {
      output_index: outputIndex,
      item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    this.#event("response.content_part.added", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { ...part, text: "" },
    });
    this.#event("response.output_text.delta", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      delta: text,
    });
    this.#event("response.output_text.done", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text,
    });
    this.#event("response.content_part.done", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part,
    });
    const item = {
      id: itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [part],
    };
    this.#output.push(item);
    this.#event("response.output_item.done", { output_index: outputIndex, item });
  }

  writeToolCall(call: ToolCall): void {
    this.writeText(call.text);
    this.outputPieces += 1;
    const outputIndex = this.#output.length;
    const itemId = `fc_${outputIndex}`;
    const toolArguments = JSON.stringify(call.toolArguments);
    const item = {
      id: itemId,
      type: "function_call",
      call_id: call.toolCallId,
      name: call.toolName,
    };
    this.#event("response.output_item.added", {
      output_index: outputIndex,
      item: { ...item, status: "in_progress", arguments: "" },
    });
    this.#event("response.function_call_arguments.delta", {
      item_id: itemId,
      output_index: outputIndex,
      delta: toolArguments,
    });
    this.#event("response.function_call_arguments.done", {
      item_id: itemId,
      output_index: outputIndex,
      arguments: toolArguments,
    });
    const doneItem = { ...item, status: "completed", arguments: toolArguments };
    this.#output.push(doneItem);
    this.#event("response.output_item.done", { output_index: outputIndex, item: doneItem });
  }

  finish(): void {
    const usage = this.usage(this.outputPieces);
    this.#event("response.completed", {
      response: this.#response("completed", {
        input_tokens: usage.inputTokens + usage.cacheReadTokens,
        input_tokens_details: { cached_tokens: usage.cacheReadTokens },
        output_tokens: usage.outputTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: usage.inputTokens + usage.cacheReadTokens + usage.outputTokens,
      }),
    });
    this.response.end();
  }

  #response(status: string, usage: object | null): object {
    return {
      id: "resp_mock",
      object: "response",
      created_at: 0,
      status,
      model: this.model,
      output: status === "completed" ? this.#output : [],
      usage,
    };
  }

  #event(type: string, fields: object): void {
    this.send({ type, sequence_number: this.#sequence, ...fields }, type);
    this.#sequence += 1;
  }
}
