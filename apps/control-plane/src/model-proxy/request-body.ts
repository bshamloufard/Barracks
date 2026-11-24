import type { ProviderApiFormat } from "@barrack/model-catalogue";
import { maximumModelIdLength } from "@barrack/protocol";
import { estimateInputTokens } from "./answer-usage.js";
import type { JsonBodyScannerLimits, ScannedJsonBody } from "./json-body-scanner.js";
import {
  findModelChangingRouting,
  type OpenRouterRoutingFields,
  openRouterRoutingFields,
} from "./openrouter-routing.js";
import { type ProxyRefusal, proxyRefusals } from "./proxy-refusals.js";
import {
  type ReasoningFields,
  type ReasoningRequest,
  readReasoningRequest,
  reasoningFields,
} from "./reasoning-request.js";
import { readTopLevelMembers } from "./request-body-members.js";

/**
 * How a request's JSON may be shaped. The pinned agent's own requests, for
 * a conversation of a thousand turns with its tools and screenshots in each
 * relayed format, nest at most eleven deep and have eight top-level
 * members; these leave ample room for anything it sends and stop a body
 * built to exhaust the scanner's memory.
 */
export const requestBodyShapeLimits: JsonBodyScannerLimits = {
  maximumDepth: 128,
  maximumTopLevelMembers: 256,
  maximumTopLevelKeyBytes: 256,
};

/**
 * What the proxy reads from a relayed request's body before relaying it,
 * and the bytes it relays: the body as received, but for the members it
 * read, which are written out again as it parsed them (see
 * `request-body-members.ts`).
 *
 * Request bodies otherwise pass through unchanged: nothing here is an
 * allow-list of what a request may contain, though a request that sends a
 * document or file, or refers to input the provider keeps or fetches
 * (earlier responses, stored prompts, files, remote MCP servers), is
 * refused, since the input it adds could not be estimated.
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
  /** The input the relayed body suggests, in tokens, for an answer cut short before the provider says. */
  estimatedInputTokens: number;
  /** Whether it asks the model to reason first, tells it not to, or says neither. */
  reasoningRequest: ReasoningRequest;
};

export type BodyInspection =
  | { kind: "relayable"; body: RelayedRequestBody }
  | { kind: "refused"; refusal: ProxyRefusal; reason: string };

/**
 * The top-level fields, as the relayed providers document them, that make
 * the provider add input it keeps or fetches itself, which the body does
 * not show and an estimate from it could not count: the Responses API's
 * `previous_response_id`, `conversation` and stored `prompt`
 * (https://platform.openai.com/docs/api-reference/responses/create), and
 * Anthropic's remote `mcp_servers`
 * (https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector).
 * The pinned agent sends none of them (nor any of the parts and tools
 * `json-body-scanner.ts` notes), so they are refused in every format.
 */
const referencedInputFields = [
  "previous_response_id",
  "conversation",
  "prompt",
  "mcp_servers",
] as const;

/** The top-level members the proxy reads, in every format. */
const readKeys = new Set([
  "model",
  "stream",
  "stream_options",
  "background",
  "background_options",
  "deferred",
  "fallbacks",
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  ...reasoningFields,
  ...referencedInputFields,
]);

/** OpenRouter's requests are also read for the fields that route them. */
const openRouterReadKeys = new Set([...readKeys, ...openRouterRoutingFields]);

/**
 * Checks a request's body, scanned as it arrived (`json-body-scanner.ts`),
 * and makes the changes the proxy makes to it. Refused: anything but a
 * JSON object naming a model, and any request that would detach the
 * provider's generation from this one answer, since what it then generated
 * could never be counted.
 */
export function inspectRequestBody(
  format: ProviderApiFormat,
  providerId: string,
  received: Buffer,
  scanned: ScannedJsonBody,
  maximumBytes: number,
): BodyInspection {
  const members = readTopLevelMembers(
    received,
    scanned,
    providerId === "openrouter" ? openRouterReadKeys : readKeys,
  );
  if ("problem" in members) {
    return refused(proxyRefusals.invalidRequestBody, members.problem);
  }
  const fields = Object.fromEntries(members.values) as RequestFields;
  const model = fields.model;
  if (typeof model !== "string" || model === "" || model.length > maximumModelIdLength) {
    return refused(proxyRefusals.invalidRequestBody, "the body names no model");
  }
  const routing = providerId === "openrouter" ? findModelChangingRouting(fields) : undefined;
  if (routing !== undefined) {
    return refused(proxyRefusals.modelRoutingRefused, routing);
  }
  const detachment = findDetachedGeneration(format, fields);
  if (detachment !== undefined) {
    return refused(proxyRefusals.detachedGenerationRefused, detachment);
  }
  const referencedInput = findReferencedInput(fields, scanned);
  if (referencedInput !== undefined) {
    return refused(proxyRefusals.referencedInputRefused, referencedInput);
  }
  const fallbackModels = readFallbackModels(format, fields);
  if (fallbackModels === undefined) {
    return refused(
      proxyRefusals.invalidRequestBody,
      "its fallback models are not a list of models",
    );
  }
  const isStreamed = fields.stream === true;
  const bytes = members.rebuild(
    format === "openai_chat_completions" && isStreamed
      ? new Map([["stream_options", askForStreamedUsage(fields.stream_options)]])
      : new Map(),
  );
  if (bytes.length > maximumBytes) {
    return refused(proxyRefusals.requestTooLarge, "the body written out again is too large");
  }
  return {
    kind: "relayable",
    body: {
      bytes,
      model,
      fallbackModels,
      isStreamed,
      maximumOutputTokens: readMaximumOutputTokens(format, fields),
      estimatedInputTokens: estimateInputTokens(bytes.length, scanned),
      reasoningRequest: readReasoningRequest(fields),
    },
  };
}

/** The fields the proxy reads, of a body that may hold anything else too. */
type RequestFields = ReasoningFields &
  OpenRouterRoutingFields &
  Partial<Record<(typeof referencedInputFields)[number], unknown>> &
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

/**
 * A streamed Chat Completions answer reports its usage only when asked
 * (`stream_options.include_usage`); without it the proxy could count only
 * the visible text, missing hidden reasoning. The pinned agent asks for it
 * of every relayed provider already (pi-ai's `openai-completions.js`, whose
 * detection sets `supportsUsageInStreaming` for all of them), so this
 * changes only a request something else in the sandbox wrote.
 * https://platform.openai.com/docs/api-reference/chat/create#chat-create-stream_options
 */
function askForStreamedUsage(options: unknown): object {
  const isObject = typeof options === "object" && options !== null && !Array.isArray(options);
  return { ...(isObject ? options : {}), include_usage: true };
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
function findDetachedGeneration(
  format: ProviderApiFormat,
  fields: RequestFields,
): string | undefined {
  switch (format) {
    case "openai_responses":
      if (isSet(fields.background) || isSet(fields.background_options)) {
        return "it asks for a background response";
      }
      return undefined;
    case "openai_chat_completions":
      return isSet(fields.deferred) ? "it asks for a deferred completion" : undefined;
    case "anthropic_messages":
      return undefined;
  }
}

/** What in the body refers to input the provider keeps or fetches, if anything does. */
function findReferencedInput(fields: RequestFields, scanned: ScannedJsonBody): string | undefined {
  const field = referencedInputFields.find((name) => isSet(fields[name]));
  if (field !== undefined) {
    return `it refers to stored or remote input (\`${field}\`)`;
  }
  if (scanned.referencedInputType !== undefined) {
    return `it sends or refers to input of type \`${scanned.referencedInputType}\``;
  }
  return undefined;
}

/** Present with any value but `false` or `null`, either of which a provider takes as unset. */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/** Anthropic's `fallbacks`, `[{ model }]`, the models it may answer with if the one asked for cannot. */
function readFallbackModels(
  format: ProviderApiFormat,
  fields: RequestFields,
): string[] | undefined {
  if (format !== "anthropic_messages" || fields.fallbacks === undefined) {
    return [];
  }
  if (!Array.isArray(fields.fallbacks)) {
    return undefined;
  }
  const models: string[] = [];
  for (const fallback of fields.fallbacks) {
    const model: unknown = (fallback as { model?: unknown } | null)?.model;
    if (typeof model !== "string") {
      return undefined;
    }
    models.push(model);
  }
  return models;
}

/**
 * Each format's own field for the most output to generate. Chat
 * Completions has two, `max_completion_tokens` and the older `max_tokens`,
 * and some of the hosts relayed honour only the older one, so the larger
 * of those given counts.
 */
function readMaximumOutputTokens(
  format: ProviderApiFormat,
  fields: RequestFields,
): number | undefined {
  const stated =
    format === "anthropic_messages"
      ? [fields.max_tokens]
      : format === "openai_responses"
        ? [fields.max_output_tokens]
        : [fields.max_completion_tokens, fields.max_tokens];
  const counts = stated.filter(
    (value): value is number => Number.isSafeInteger(value) && (value as number) >= 0,
  );
  return counts.length === 0 ? undefined : Math.max(...counts);
}

function refused(refusal: ProxyRefusal, reason: string): BodyInspection {
  return { kind: "refused", refusal, reason };
}
