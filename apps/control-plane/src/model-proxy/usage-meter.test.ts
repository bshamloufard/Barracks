import { describe, expect, it } from "vitest";
import { describeAnswerUsage } from "./answer-usage.js";
import { UsageMeter } from "./usage-meter.js";

/**
 * Answers as each provider's API reference shows them, fed to the meter in
 * awkward pieces (a byte at a time across an event and its boundary) to
 * show nothing depends on how the stream was cut.
 */

function sse(events: object[]): string {
  return events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function meterOf(
  format: ConstructorParameters<typeof UsageMeter>[0],
  text: string,
  pieceLength = 7,
  contentType = "text/event-stream; charset=utf-8",
) {
  const meter = new UsageMeter(format, contentType);
  const bytes = Buffer.from(text);
  for (let start = 0; start < bytes.length; start += pieceLength) {
    meter.write(bytes.subarray(start, start + pieceLength));
  }
  return meter.finish();
}

const anthropicStart = {
  type: "message_start",
  message: {
    model: "claude-x",
    usage: {
      input_tokens: 120,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 400,
      output_tokens: 1,
    },
  },
};

describe("reading usage from an answer", () => {
  it("reads Anthropic's streamed counts, the output from the cumulative message_delta", () => {
    const usage = meterOf(
      "anthropic_messages",
      sse([
        anthropicStart,
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } },
        { type: "message_stop" },
      ]),
      1,
    );

    expect(usage).toMatchObject({
      modelId: "claude-x",
      inputTokens: 120,
      outputTokens: 15,
      cacheReadTokens: 400,
      cacheWriteTokens: 30,
      isFinal: true,
      generatedCharacters: 5,
    });
  });

  it("reads OpenAI's Responses usage from response.completed, taking the cached tokens out of the input", () => {
    const usage = meterOf(
      "openai_responses",
      sse([
        { type: "response.created", response: { model: "gpt-x", usage: null } },
        { type: "response.output_text.delta", delta: "Hello there" },
        {
          type: "response.completed",
          response: {
            model: "gpt-x",
            usage: {
              input_tokens: 500,
              input_tokens_details: { cached_tokens: 200 },
              output_tokens: 42,
            },
          },
        },
      ]),
    );

    expect(usage).toMatchObject({
      modelId: "gpt-x",
      inputTokens: 300,
      cacheReadTokens: 200,
      outputTokens: 42,
      isFinal: true,
      generatedCharacters: 11,
    });
  });

  it("reads Chat Completions usage from the last chunk, ignoring [DONE]", () => {
    const usage = meterOf(
      "openai_chat_completions",
      `${sse([
        { model: "llama-x", choices: [{ delta: { content: "Hi" } }] },
        {
          model: "llama-x",
          choices: [{ delta: { tool_calls: [{ function: { arguments: '{"a":1}' } }] } }],
        },
        {
          model: "llama-x",
          choices: [],
          usage: {
            prompt_tokens: 90,
            completion_tokens: 9,
            prompt_tokens_details: { cached_tokens: 10 },
          },
        },
      ])}data: [DONE]\n\n`,
    );

    expect(usage).toMatchObject({
      modelId: "llama-x",
      inputTokens: 80,
      cacheReadTokens: 10,
      outputTokens: 9,
      isFinal: true,
      generatedCharacters: 9,
    });
  });

  it("reads a non-streamed answer's usage from its body", () => {
    const usage = meterOf(
      "anthropic_messages",
      JSON.stringify({
        type: "message",
        model: "claude-x",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      3,
      "application/json",
    );

    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 4, isFinal: true });
  });

  it("is not final when the stream is cut short, and is then estimated from what was seen", () => {
    const usage = meterOf(
      "anthropic_messages",
      `${sse([
        anthropicStart,
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "x".repeat(400) },
        },
      ])}data: {"type":"content_block_del`,
    );
    const counted = describeAnswerUsage({
      upstreamStatus: 200,
      interruption: "agent_went_away",
      requestBytes: 4_000,
      responseBytes: 2_000,
      usage,
    });

    expect(usage.isFinal).toBe(false);
    expect(counted).toEqual({
      modelId: "claude-x",
      source: "estimated",
      inputTokens: 120,
      outputTokens: 100,
      cacheReadTokens: 400,
      cacheWriteTokens: 30,
    });
  });

  it("estimates the input from the request's size when the provider never said it", () => {
    const usage = meterOf(
      "openai_responses",
      sse([{ type: "response.output_text.delta", delta: "y".repeat(80) }]),
    );

    expect(
      describeAnswerUsage({
        upstreamStatus: 200,
        interruption: "timed_out",
        requestBytes: 4_000,
        responseBytes: 500,
        usage,
      }),
    ).toMatchObject({
      source: "estimated",
      inputTokens: 1_000,
      outputTokens: 20,
      modelId: "unknown",
    });
  });

  it("counts nothing for a refused request", () => {
    const usage = meterOf(
      "openai_responses",
      JSON.stringify({ error: { message: "nope" } }),
      5,
      "application/json",
    );

    expect(
      describeAnswerUsage({
        upstreamStatus: 401,
        interruption: undefined,
        requestBytes: 100,
        responseBytes: 30,
        usage,
      }),
    ).toBeUndefined();
  });

  it("gives up reading, but keeps estimating, an event too long to hold", () => {
    const usage = meterOf("openai_chat_completions", `data: ${"z".repeat(1_200_000)}`, 64 * 1024);

    expect(usage.isFinal).toBe(false);
    expect(usage.generatedCharacters).toBeGreaterThan(500_000);
  });
});
