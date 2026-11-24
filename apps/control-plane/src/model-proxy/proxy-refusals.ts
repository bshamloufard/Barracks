import type { ServerResponse } from "node:http";
import type { ProviderApiFormat } from "@barrack/model-catalogue";

/**
 * The proxy's own refusals, written as the provider would write an error
 * in the request's format, so the agent's client reports them as it would
 * the provider's own: its status and message reach the thread, where the
 * harness classifies them like any provider error. The wording is chosen
 * for that: a cap reached says "model usage cap" (the harness's
 * `usage_cap_reached`), a missing key "no API key found" (its
 * `credential_missing`), and a refused token avoids the words that would
 * tell the user to replace their key. What is worth retrying (too many
 * requests at once, the proxy busy or briefly unable to decide, the
 * provider unreachable) has a status the agent retries; nothing else does,
 * so a thread whose cap is reached ends its run instead of asking again.
 *
 * Nothing here repeats anything secret, and none of it is the provider's.
 */
export type ProxyRefusal = {
  status: number;
  /** The error's type as the format names such things. */
  errorType: string;
  message: string;
  /** Seconds to wait before retrying, for refusals worth retrying. */
  retryAfterSeconds?: number;
};

export const proxyRefusals = {
  notFound: {
    status: 404,
    errorType: "not_found_error",
    message: "Barrack's model proxy relays no such request for this provider.",
  },
  methodNotAllowed: {
    status: 405,
    errorType: "invalid_request_error",
    message: "Barrack's model proxy relays this path only with POST.",
  },
  tokenRefused: {
    status: 403,
    errorType: "permission_error",
    message:
      "Barrack's model proxy does not accept this sandbox's token for this thread and provider: the thread is not running, it now runs on another provider, or its token was revoked.",
  },
  ownerNotAdmitted: {
    status: 403,
    errorType: "permission_error",
    message:
      "This Barrack installation does not admit the thread's owner (or cannot confirm it still does until they sign in again), so their key is not used.",
  },
  invalidRequestBody: {
    status: 400,
    errorType: "invalid_request_error",
    message:
      "Barrack's model proxy relays only a request whose body is a JSON object naming a model.",
  },
  detachedGenerationRefused: {
    status: 400,
    errorType: "invalid_request_error",
    message:
      "Barrack's model proxy does not relay background or deferred requests: what the provider generated after answering could not be counted towards the usage cap.",
  },
  modelRoutingRefused: {
    status: 403,
    errorType: "permission_error",
    message:
      "Barrack's model proxy relays this thread's requests only to its own model, without OpenRouter's plugins, and this request asks for another model or a plugin (OpenRouter's models, route, preset, provider options or plugins).",
  },
  requestTooLarge: {
    status: 413,
    errorType: "request_too_large",
    message: "The request is larger than Barrack's model proxy relays.",
  },
  requestBodyTooSlow: {
    status: 408,
    errorType: "request_timeout",
    message: "The request's body took longer to arrive than Barrack's model proxy waits.",
  },
  tooManyBytesAtOnce: {
    status: 429,
    errorType: "rate_limit_error",
    message:
      "This thread's requests, or its owner's, hold as many bytes at once as Barrack's model proxy allows them.",
    retryAfterSeconds: 2,
  },
  tooManyAtOnce: {
    status: 429,
    errorType: "rate_limit_error",
    message: "Too many requests from this thread at once through Barrack's model proxy.",
    retryAfterSeconds: 2,
  },
  proxyBusy: {
    status: 503,
    errorType: "overloaded_error",
    message: "Barrack's model proxy is busy: the service is temporarily unavailable.",
    retryAfterSeconds: 5,
  },
  cannotDecide: {
    status: 503,
    errorType: "api_error",
    message:
      "Barrack's model proxy cannot check this request now: the service is temporarily unavailable.",
    retryAfterSeconds: 5,
  },
  upstreamUnreachable: {
    status: 502,
    errorType: "api_error",
    message: "Barrack's model proxy could not reach the provider: connection error.",
  },
  upstreamTooSlow: {
    status: 504,
    errorType: "api_error",
    message: "The provider did not answer Barrack's model proxy in time: timed out.",
  },
} as const satisfies Record<string, ProxyRefusal>;

export function credentialMissingRefusal(providerId: string): ProxyRefusal {
  return {
    status: 403,
    errorType: "permission_error",
    message: `No API key found for the provider "${providerId}" among the thread owner's keys in Barrack. Add one in Settings, then send your message again.`,
  };
}

export function modelRefusal(threadModel: string): ProxyRefusal {
  return {
    status: 403,
    errorType: "permission_error",
    message: `Barrack's model proxy relays this thread's requests only for its own model, "${threadModel}", and this request names another.`,
  };
}

export function usageCapRefusal(explanation: string): ProxyRefusal {
  return { status: 403, errorType: "permission_error", message: explanation };
}

/** Writes the refusal as the format's own error body, unless the agent has hung up. */
export function sendRefusal(
  response: ServerResponse,
  format: ProviderApiFormat | undefined,
  refusal: ProxyRefusal,
): void {
  if (response.destroyed) {
    return;
  }
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body =
    format === "anthropic_messages"
      ? { type: "error", error: { type: refusal.errorType, message: refusal.message } }
      : { error: { message: refusal.message, type: refusal.errorType, code: null } };
  response.writeHead(refusal.status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...(refusal.retryAfterSeconds === undefined
      ? {}
      : { "retry-after": String(refusal.retryAfterSeconds) }),
  });
  response.end(JSON.stringify(body));
}
