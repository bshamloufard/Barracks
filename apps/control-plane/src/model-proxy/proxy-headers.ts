import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import type { AgentRequestShape, ProviderApiFormat } from "@barrack/model-catalogue";
import { bearerTokenFrom } from "../bearer-token.js";

/**
 * Which headers cross the proxy. Requests are rebuilt from an allow-list:
 * what the provider needs to read the body and choose API features, and
 * the identifiers some providers route prompt caching by; never the
 * sandbox's own credential, which is replaced by the owner's key. Answers
 * keep only what the agent's client reads: the body's type, and what it
 * says about retrying and rate limits. Any value holding the key is
 * dropped, whatever its name.
 */

const forwardedRequestHeaders = new Set([
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "x-session-id",
  "x-session-affinity",
  "x-client-request-id",
  "session_id",
]);

const forwardedResponseHeaders = new Set([
  "content-type",
  "retry-after",
  "retry-after-ms",
  "x-should-retry",
  "request-id",
  "x-request-id",
]);

const forwardedResponseHeaderPrefixes = ["anthropic-ratelimit-", "x-ratelimit-"];

/** Longer than any header value the agent's clients send. */
const maximumForwardedValueLength = 1024;

/** The token the agent presented: Anthropic's clients send `x-api-key`, OpenAI's a bearer token. */
export function readPresentedToken(headers: IncomingHttpHeaders): string | undefined {
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey !== "") {
    return apiKey;
  }
  return bearerTokenFrom(headers.authorization);
}

/**
 * Anthropic's `anthropic-beta` header turns on features of the API, among
 * them ones that run more sampling steps or tools of the provider's own; it
 * is forwarded only when each of its comma-separated values is one the
 * agent sends (`AgentRequestShape.betaHeaderValues`). Returns what is not,
 * named for a refusal, or undefined.
 */
export function findUnrelayedHeaderValue(
  headers: IncomingHttpHeaders,
  shape: AgentRequestShape,
): string | undefined {
  const betas = headers["anthropic-beta"];
  const values = (Array.isArray(betas) ? betas.join(",") : (betas ?? "")).split(",");
  for (const value of values.map((written) => written.trim())) {
    if (value !== "" && !shape.betaHeaderValues.includes(value)) {
      return /^[a-z0-9-]{1,64}$/.test(value)
        ? `the anthropic-beta value \`${value}\``
        : "an anthropic-beta value that is not a plain name";
    }
  }
  return undefined;
}

export function buildUpstreamHeaders(
  format: ProviderApiFormat,
  incoming: IncomingHttpHeaders,
  ownerKey: string,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (
      forwardedRequestHeaders.has(name) &&
      typeof value === "string" &&
      value.length <= maximumForwardedValueLength
    ) {
      headers[name] = value;
    }
  }
  // The body is JSON the scanner found to be UTF-8, whatever the agent
  // said it was (a charset given with it could make the provider read it
  // otherwise than the proxy did).
  headers["content-type"] = "application/json";
  // The proxy reads usage from the answer, so it asks for it uncompressed;
  // one compressed all the same is decompressed (see `model-proxy.ts`).
  headers["accept-encoding"] = "identity";
  if (format === "anthropic_messages") {
    headers["x-api-key"] = ownerKey;
  } else {
    headers.authorization = `Bearer ${ownerKey}`;
  }
  return headers;
}

export function buildDownstreamHeaders(
  upstream: IncomingHttpHeaders,
  ownerKey: string,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { "cache-control": "no-store" };
  for (const [name, value] of Object.entries(upstream)) {
    const isForwarded =
      forwardedResponseHeaders.has(name) ||
      forwardedResponseHeaderPrefixes.some((prefix) => name.startsWith(prefix));
    if (
      isForwarded &&
      typeof value === "string" &&
      value.length <= maximumForwardedValueLength &&
      !value.includes(ownerKey)
    ) {
      headers[name] = value;
    }
  }
  return headers;
}
