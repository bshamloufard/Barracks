import type { IncomingMessage } from "node:http";
import type { ProviderApiFormat } from "@barrack/model-catalogue";
import { maximumModelIdLength } from "@barrack/protocol";
import { type ProxyRefusal, proxyRefusals } from "./proxy-refusals.js";

/**
 * What the proxy reads from a relayed request's body before relaying it,
 * and the bytes it relays: the body as it parsed it, written out again, so
 * the provider is sent exactly what was checked (a body with a key twice,
 * say, cannot mean one thing here and another to the provider).
 *
 * Request bodies otherwise pass through unchanged: nothing here is an
 * allow-list of what a request may contain, and a request may refer to
 * objects the provider keeps (files, earlier responses) by identifier.
 */
export type RelayedRequestBody = {
  /** What is sent to the provider. */
  bytes: Buffer;
  /** The model the request names. */
  model: string;
  /** Other models the provider may answer with instead (Anthropic's `fallbacks`). */
  fallbackModels: string[];
  /** Whether the answer is asked for as a stream of events. */
  isStreamed: boolean;
  /** The most output the request allows, when it says. */
  maximumOutputTokens: number | undefined;
};

export type BodyInspection =
  | { kind: "relayable"; body: RelayedRequestBody }
  | { kind: "refused"; refusal: ProxyRefusal; reason: string };

/**
 * Checks a request's body, and makes the changes the proxy makes to it.
 * Refused: anything but a JSON object naming a model, and any request that
 * would detach the provider's generation from this one answer, since what
 * it then generated could never be counted.
 */
export function inspectRequestBody(format: ProviderApiFormat, received: Buffer): BodyInspection {
  const parsed = parseJsonObject(received);
  if (parsed === undefined) {
    return refused(proxyRefusals.invalidRequestBody, "the body is not a JSON object");
  }
  const model = parsed.model;
  if (typeof model !== "string" || model === "" || model.length > maximumModelIdLength) {
    return refused(proxyRefusals.invalidRequestBody, "the body names no model");
  }
  const detachment = findDetachedGeneration(format, parsed);
  if (detachment !== undefined) {
    return refused(proxyRefusals.detachedGenerationRefused, detachment);
  }
  const fallbackModels = readFallbackModels(format, parsed);
  if (fallbackModels === undefined) {
    return refused(
      proxyRefusals.invalidRequestBody,
      "its fallback models are not a list of models",
    );
  }
  return {
    kind: "relayable",
    body: {
      bytes: Buffer.from(JSON.stringify(parsed)),
      model,
      fallbackModels,
      isStreamed: parsed.stream === true,
      maximumOutputTokens: readMaximumOutputTokens(format, parsed),
    },
  };
}

/** The fields the proxy reads, of a body that may hold anything else too. */
type JsonObject = Record<string, unknown> &
  Partial<
    Record<
      | "model"
      | "stream"
      | "stream_options"
      | "background"
      | "background_options"
      | "deferred"
      | "fallbacks"
      | "max_tokens"
      | "max_output_tokens"
      | "max_completion_tokens",
      unknown
    >
  >;

function parseJsonObject(received: Buffer): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(received.toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The request fields, as each provider documents them, that answer at once
 * and leave the provider generating on its own, to be fetched later through
 * a path the proxy does not relay:
 * - OpenAI's Responses API `background` (and `background_options`, which
 *   needs it): https://developers.openai.com/api/docs/guides/background
 *   (xAI's Responses API lists `background` as unsupported, and is refused
 *   the same way.)
 * - xAI's Chat Completions `deferred`:
 *   https://docs.x.ai/developers/advanced-api-usage/deferred-chat-completions
 * Anthropic's Messages API has none; its batches are another path.
 */
function findDetachedGeneration(format: ProviderApiFormat, body: JsonObject): string | undefined {
  switch (format) {
    case "openai_responses":
      if (isSet(body.background) || isSet(body.background_options)) {
        return "it asks for a background response";
      }
      return undefined;
    case "openai_chat_completions":
      return isSet(body.deferred) ? "it asks for a deferred completion" : undefined;
    case "anthropic_messages":
      return undefined;
  }
}

/** Present with any value but `false` or `null`, either of which a provider takes as unset. */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/** Anthropic's `fallbacks`, `[{ model }]`, the models it may answer with if the one asked for cannot. */
function readFallbackModels(format: ProviderApiFormat, body: JsonObject): string[] | undefined {
  if (format !== "anthropic_messages" || body.fallbacks === undefined) {
    return [];
  }
  if (!Array.isArray(body.fallbacks)) {
    return undefined;
  }
  const models: string[] = [];
  for (const fallback of body.fallbacks) {
    const model: unknown = (fallback as JsonObject | null)?.model;
    if (typeof model !== "string") {
      return undefined;
    }
    models.push(model);
  }
  return models;
}

/** Each format's own field for the most output to generate; Chat Completions has two. */
function readMaximumOutputTokens(format: ProviderApiFormat, body: JsonObject): number | undefined {
  const stated =
    format === "anthropic_messages"
      ? body.max_tokens
      : format === "openai_responses"
        ? body.max_output_tokens
        : (body.max_completion_tokens ?? body.max_tokens);
  return Number.isSafeInteger(stated) && (stated as number) >= 0 ? (stated as number) : undefined;
}

function refused(refusal: ProxyRefusal, reason: string): BodyInspection {
  return { kind: "refused", refusal, reason };
}

export type BodyReading =
  | { kind: "read"; bytes: Buffer; release: () => void }
  | { kind: "too_large" | "proxy_busy" | "agent_went_away" };

/**
 * Bytes of request bodies held at once by this instance while they are
 * read and relayed, so that many large requests together cannot exhaust its
 * memory. Each request takes its share as its bytes arrive and gives it
 * back once relayed.
 */
export class RequestBodyBudget {
  readonly #limit: number;
  #held = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get held(): number {
    return this.#held;
  }

  /**
   * Reads the whole body, refusing one larger than `maximumBytes` or one
   * that would take the instance over its budget. A reading that ends in
   * anything but `read` holds nothing.
   */
  read(request: IncomingMessage, maximumBytes: number): Promise<BodyReading> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let taken = 0;
      const giveBack = () => {
        this.#held -= taken;
        taken = 0;
      };
      const stop = (kind: "too_large" | "proxy_busy" | "agent_went_away") => {
        request.removeAllListeners("data");
        giveBack();
        resolve({ kind });
      };
      request.on("data", (chunk: Buffer) => {
        if (taken + chunk.length > maximumBytes) {
          stop("too_large");
          return;
        }
        if (this.#held + chunk.length > this.#limit) {
          stop("proxy_busy");
          return;
        }
        this.#held += chunk.length;
        taken += chunk.length;
        chunks.push(chunk);
      });
      request.once("end", () => {
        let isReleased = false;
        resolve({
          kind: "read",
          bytes: Buffer.concat(chunks),
          release: () => {
            if (!isReleased) {
              isReleased = true;
              giveBack();
            }
          },
        });
      });
      request.once("error", () => stop("agent_went_away"));
      request.once("close", () => {
        if (!request.complete) {
          stop("agent_went_away");
        }
      });
    });
  }
}
