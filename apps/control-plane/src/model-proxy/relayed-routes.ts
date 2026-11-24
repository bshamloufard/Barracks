import { findRelayedProvider, type ProviderApiFormat } from "@barrack/model-catalogue";

/**
 * The only requests the model proxy forwards: for each wire format, one
 * method, one path below the provider's base URL, and the query strings
 * the agent's own client adds. Anything else is refused before any
 * credential is read. The upstream is the provider's own base URL from
 * `relayed-providers.ts`, never anything the request says.
 *
 * Anthropic's client asks for its beta features with `?beta=true`.
 */
const allowedRequests: Readonly<
  Record<ProviderApiFormat, { method: string; path: string; queries: readonly string[] }>
> = {
  anthropic_messages: { method: "POST", path: "/v1/messages", queries: ["", "beta=true"] },
  openai_responses: { method: "POST", path: "/responses", queries: [""] },
  openai_chat_completions: { method: "POST", path: "/chat/completions", queries: [""] },
};

export type RelayedRoute = {
  format: ProviderApiFormat;
  /** Where the request goes: the provider's own address, path and query. */
  upstreamUrl: URL;
};

export type RouteLookup =
  | { kind: "found"; route: RelayedRoute }
  | { kind: "not_relayed" }
  | { kind: "method_not_allowed" }
  | { kind: "path_not_allowed" };

/**
 * `upstreamOrigin`, for tests and local development only, replaces the
 * scheme, host and port of every provider's address (keeping its path), so
 * the proxy can be pointed at a mock; see the configuration's
 * `BARRACK_MODEL_PROXY_UPSTREAM_ORIGIN`.
 */
export function findRelayedRoute(
  request: { providerId: string; method: string; apiPath: string; query: string },
  upstreamOrigin: string | undefined,
): RouteLookup {
  const provider = findRelayedProvider(request.providerId);
  if (provider === undefined) {
    return { kind: "not_relayed" };
  }
  const api = provider.apis.find((candidate) => {
    const allowed = allowedRequests[candidate.format];
    return allowed.path === request.apiPath && allowed.queries.includes(request.query);
  });
  if (api === undefined) {
    return { kind: "path_not_allowed" };
  }
  if (request.method !== allowedRequests[api.format].method) {
    return { kind: "method_not_allowed" };
  }
  const upstreamUrl = new URL(`${api.upstreamBaseUrl}${request.apiPath}`);
  if (upstreamOrigin !== undefined) {
    const replacement = new URL(upstreamOrigin);
    upstreamUrl.protocol = replacement.protocol;
    upstreamUrl.host = replacement.host;
  }
  upstreamUrl.search = request.query;
  return { kind: "found", route: { format: api.format, upstreamUrl } };
}
