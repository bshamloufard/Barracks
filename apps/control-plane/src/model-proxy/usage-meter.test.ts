import { findLargestMaxOutputTokens } from "@barrack/model-catalogue";
import { describe, expect, it } from "vitest";
import { inspectWholeBody } from "../test-support/request-bodies.js";
import {
  defaultMaximumOutputTokens,
  describeAnswerUsage,
  mayReasonUnseen,
  resolveMaximumOutputTokens,
  tokensPerImage,
} from "./answer-usage.js";
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

/** A streamed request whose body suggests `estimatedInputTokens`, as the proxy read it. */
function streamedRequest(estimatedInputTokens: number) {
  return {
    model: "requested-model",
    estimatedInputTokens,
    maximumOutputTokens: 4_096,
    isStreamed: true,
    mayReasonUnseen: false,
  };
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
    const counted = describeAnswerUsage(
      {
        upstreamStatus: 200,
        interruption: "agent_went_away",
        wasRequestSent: true,
        responseBytes: 2_000,
        usage,
      },
      streamedRequest(1_000),
    );

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
      describeAnswerUsage(
        {
          upstreamStatus: 200,
          interruption: "timed_out",
          wasRequestSent: true,
          responseBytes: 500,
          usage,
        },
        streamedRequest(1_000),
      ),
    ).toMatchObject({
      source: "estimated",
      inputTokens: 1_000,
      outputTokens: 20,
      modelId: "requested-model",
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
      describeAnswerUsage(
        {
          upstreamStatus: 401,
          interruption: undefined,
          wasRequestSent: true,
          responseBytes: 30,
          usage,
        },
        streamedRequest(25),
      ),
    ).toBeUndefined();
  });

  it("estimates a request sent whole but never answered at the most output it allowed", () => {
    expect(
      describeAnswerUsage(
        {
          upstreamStatus: undefined,
          interruption: "agent_went_away",
          wasRequestSent: true,
          responseBytes: 0,
          usage: undefined,
        },
        {
          model: "a-model",
          estimatedInputTokens: 1_000_000,
          maximumOutputTokens: 32_000,
          isStreamed: false,
          mayReasonUnseen: false,
        },
      ),
    ).toEqual({
      modelId: "a-model",
      source: "estimated",
      inputTokens: 1_000_000,
      outputTokens: 32_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("counts nothing for a request the provider never received whole", () => {
    expect(
      describeAnswerUsage(
        {
          upstreamStatus: undefined,
          interruption: "upstream_failed",
          wasRequestSent: false,
          responseBytes: 0,
          usage: undefined,
        },
        {
          model: "a-model",
          estimatedInputTokens: 100,
          maximumOutputTokens: 1_000,
          isStreamed: true,
          mayReasonUnseen: false,
        },
      ),
    ).toBeUndefined();
  });

  it("estimates a non-streamed answer without the provider's figures at the most output it allowed", () => {
    const usage = meterOf(
      "openai_responses",
      JSON.stringify({ object: "response", status: "completed", model: "a-model", usage: null }),
      5,
      "application/json",
    );

    expect(
      describeAnswerUsage(
        {
          upstreamStatus: 200,
          interruption: undefined,
          wasRequestSent: true,
          responseBytes: 100,
          usage,
        },
        {
          model: "a-model",
          estimatedInputTokens: 100,
          maximumOutputTokens: 128_000,
          isStreamed: false,
          mayReasonUnseen: false,
        },
      ),
    ).toMatchObject({ source: "estimated", inputTokens: 100, outputTokens: 128_000 });
  });

  it("estimates the input from the body relayed: no whitespace, and each image at a stated figure", () => {
    const screenshot = "iVBORw0KGgoAAAANSUhEUg".repeat(20_000);
    const words = "word ".repeat(2_000);
    const body = `{"model":"a-model","max_tokens":8,"messages":[{"role":"user","content":[
      {"type":"text","text":"${words}"},
      {"type":"image","source":{"type":"base64","media_type":"image/png","data":"${screenshot}"}},
      {"type":"image","source":{"type":"base64","media_type":"image/png","data":"${screenshot}"}}
    ]}]${" ".repeat(1_000_000)}}`;
    const inspection = inspectWholeBody("anthropic_messages", body);

    expect(inspection.kind).toBe("relayable");
    const estimated = inspection.kind === "relayable" ? inspection.body.estimatedInputTokens : 0;
    expect(estimated).toBeGreaterThanOrEqual(words.length / 4 + 2 * tokensPerImage);
    expect(estimated).toBeLessThan(words.length / 4 + 2 * tokensPerImage + 200);
  });

  it("counts a request that states no maximum at its model's own, or its provider's largest", () => {
    expect(resolveMaximumOutputTokens("openai", "gpt-4", undefined)).toBe(8_192);
    expect(resolveMaximumOutputTokens("openai", "gpt-4", 100)).toBe(100);
    expect(resolveMaximumOutputTokens("openai", "a-model-it-does-not-list", undefined)).toBe(
      findLargestMaxOutputTokens("openai"),
    );
    expect(resolveMaximumOutputTokens("unlisted-provider", "a-model", undefined)).toBe(
      defaultMaximumOutputTokens,
    );
  });

  it("gives up reading, but keeps estimating, an event too long to hold", () => {
    const usage = meterOf("openai_chat_completions", `data: ${"z".repeat(1_200_000)}`, 64 * 1024);

    expect(usage.isFinal).toBe(false);
    expect(usage.generatedCharacters).toBeGreaterThan(500_000);
  });
});

describe("an answer cut short after reasoning it did not show", () => {
  const cutShort = (usage: ReturnType<typeof meterOf>) => ({
    upstreamStatus: 200,
    interruption: "agent_went_away" as const,
    wasRequestSent: true,
    responseBytes: 1_000,
    usage,
  });
  const streamed = (mayReasonUnseen: boolean) => ({
    model: "a-model",
    estimatedInputTokens: 100,
    maximumOutputTokens: 64_000,
    isStreamed: true,
    mayReasonUnseen,
  });

  it("sees reasoning begin in each format, though its text is not shown", () => {
    const responses = meterOf(
      "openai_responses",
      sse([
        { type: "response.created", response: { model: "a-model", usage: null } },
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs" } },
      ]),
    );
    const anthropic = meterOf(
      "anthropic_messages",
      sse([
        anthropicStart,
        { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking" } },
      ]),
    );
    const chat = meterOf(
      "openai_chat_completions",
      sse([{ model: "a-model", choices: [{ delta: { reasoning_content: "Hmm" } }] }]),
    );
    const plain = meterOf(
      "openai_chat_completions",
      sse([{ model: "a-model", choices: [{ delta: { content: "Hello" } }] }]),
    );

    expect([responses, anthropic, chat, plain].map((usage) => usage.sawReasoning)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("counts the most output the request allowed once reasoning was seen or may have been hidden", () => {
    const afterReasoning = meterOf(
      "openai_responses",
      sse([
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs" } },
        { type: "response.output_text.delta", delta: "Hi" },
      ]),
    );
    const plainText = meterOf(
      "openai_responses",
      sse([{ type: "response.output_text.delta", delta: "x".repeat(400) }]),
    );

    expect(describeAnswerUsage(cutShort(afterReasoning), streamed(false))?.outputTokens).toBe(
      64_000,
    );
    expect(describeAnswerUsage(cutShort(plainText), streamed(true))?.outputTokens).toBe(64_000);
    expect(describeAnswerUsage(cutShort(plainText), streamed(false))?.outputTokens).toBe(100);
  });

  it("reads whether a request asks for reasoning, in each format's own words", () => {
    const reasoningOf = (format: Parameters<typeof inspectWholeBody>[0], fields: object) => {
      const inspection = inspectWholeBody(format, { model: "m", ...fields });
      return inspection.kind === "relayable" ? inspection.body.reasoningRequest : inspection.kind;
    };
    const anthropic = "anthropic_messages";
    const responses = "openai_responses";
    const chat = "openai_chat_completions";

    expect(reasoningOf(anthropic, { thinking: { type: "enabled", budget_tokens: 9 } })).toBe("on");
    expect(reasoningOf(anthropic, { thinking: { type: "adaptive" } })).toBe("on");
    expect(reasoningOf(anthropic, { thinking: { type: "disabled" } })).toBe("off");
    expect(reasoningOf(anthropic, {})).toBe("unstated");
    expect(reasoningOf(responses, { reasoning: { effort: "high" } })).toBe("on");
    expect(reasoningOf(responses, { reasoning: { effort: "none" } })).toBe("off");
    expect(reasoningOf(chat, { reasoning_effort: "low" })).toBe("on");
    expect(reasoningOf(chat, { reasoning_effort: "none" })).toBe("off");
    expect(reasoningOf(chat, { reasoning: { enabled: false } })).toBe("off");
    expect(reasoningOf(chat, { reasoning: { exclude: true } })).toBe("on");
    expect(reasoningOf(chat, { thinking: { type: "disabled" } })).toBe("off");
    expect(reasoningOf(chat, { chat_template_kwargs: { enable_thinking: true } })).toBe("on");
    expect(reasoningOf(chat, { reasoning_effort: "high", thinking: { type: "disabled" } })).toBe(
      "on",
    );
    expect(reasoningOf(chat, {})).toBe("unstated");
  });

  it("takes a model to reason unless told not to, but for Anthropic's, which reason only when asked", () => {
    expect(mayReasonUnseen("anthropic", "claude-haiku-4-5", "unstated")).toBe(false);
    expect(mayReasonUnseen("anthropic", "claude-haiku-4-5", "on")).toBe(true);
    expect(mayReasonUnseen("openai", "gpt-4", "unstated")).toBe(false);
    expect(mayReasonUnseen("openai", "a-model-it-does-not-list", "unstated")).toBe(true);
    expect(mayReasonUnseen("openai", "a-model-it-does-not-list", "off")).toBe(false);
  });
});
