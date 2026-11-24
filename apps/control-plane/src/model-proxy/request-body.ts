import {
  type AgentRequestShape,
  isAllowedValue,
  type ProviderApiFormat,
} from "@barrack/model-catalogue";
import { maximumModelIdLength } from "@barrack/protocol";
import { estimateInputTokens } from "./answer-usage.js";
import type { JsonBodyScannerLimits, ScannedJsonBody } from "./json-body-scanner.js";
import { notRelayedRefusal, type ProxyRefusal, proxyRefusals } from "./proxy-refusals.js";
import {
  type ReasoningFields,
  type ReasoningRequest,
  readReasoningRequest,
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
 * Checks a request's body, scanned as it arrived against the shape of the
 * pinned agent's requests (`json-body-scanner.ts`), and makes the changes
 * the proxy makes to it. The scanner has refused any top-level member, and
 * any object of a type, that the agent never sends; here every member the
 * agent sends as a setting (all but its conversation, tools and system
 * prompt) is parsed and must hold one of the values the agent gives it
 * (`AgentRequestShape.members`), so no count, tier or model the agent never
 * sends reaches the provider. Refused besides: a body that names no model.
 */
export function inspectRequestBody(
  format: ProviderApiFormat,
  shape: AgentRequestShape,
  received: Buffer,
  scanned: ScannedJsonBody,
  maximumBytes: number,
): BodyInspection {
  const settings = Object.entries(shape.members).flatMap(([name, rule]) =>
    rule === "scanned" ? [] : [name],
  );
  const members = readTopLevelMembers(received, scanned, new Set(settings));
  if ("problem" in members) {
    return refused(proxyRefusals.invalidRequestBody, members.problem);
  }
  for (const [name, value] of members.values) {
    const rule = shape.members[name];
    if (!Array.isArray(rule) || !isAllowedValue(rule, value)) {
      const what = `the value given for \`${name}\``;
      return refused(notRelayedRefusal(what), `it holds ${what}, which the agent never sends`);
    }
  }
  const fields = Object.fromEntries(members.values) as RequestFields;
  const model = fields.model;
  if (typeof model !== "string" || model === "" || model.length > maximumModelIdLength) {
    return refused(proxyRefusals.invalidRequestBody, "the body names no model");
  }
  const isStreamed = fields.stream === true;
  const bytes = members.rebuild(
    format === "openai_chat_completions" && isStreamed && fields.stream_options === undefined
      ? new Map([["stream_options", { include_usage: true }]])
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
      fallbackModels: readFallbackModels(fields.fallbacks),
      isStreamed,
      maximumOutputTokens: readMaximumOutputTokens(format, fields),
      estimatedInputTokens: estimateInputTokens(bytes.length, scanned),
      reasoningRequest: readReasoningRequest(fields),
    },
  };
}

/** The fields the proxy reads, each already one of the values the agent sends. */
type RequestFields = ReasoningFields &
  Partial<
    Record<
      | "model"
      | "stream"
      | "stream_options"
      | "fallbacks"
      | "max_tokens"
      | "max_output_tokens"
      | "max_completion_tokens",
      unknown
    >
  >;

/**
 * Anthropic's `fallbacks`, `[{ model }]`, the models it may answer with if
 * the one asked for cannot. The allow-list lets through only lists the
 * agent sends, each for some model; whether it is the list for the model
 * requested is checked with the thread's model (`ModelProxyAuthorization`).
 */
function readFallbackModels(fallbacks: unknown): string[] {
  if (!Array.isArray(fallbacks)) {
    return [];
  }
  return fallbacks.flatMap((fallback: { model?: unknown }) =>
    typeof fallback.model === "string" ? [fallback.model] : [],
  );
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
