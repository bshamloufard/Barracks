/**
 * The providers whose traffic the control plane relays, so their keys stay
 * on the server: the one place that says which they are. The control plane
 * forwards to the upstream named here and nowhere else, and the web client
 * learns from the catalogue (`keyPlacement`) where each key lives.
 *
 * A provider is listed only when every model the pinned agent offers for
 * it speaks one of the wire formats below, at a fixed address on the
 * provider's own host, authenticated by the key alone, which is what lets
 * the proxy forward it unchanged and read its usage. A test checks each
 * entry against the pinned agent (`scripts/relayed-providers-match-pinned-agent.test.ts`).
 * Every other provider keeps its key in the sandbox: Google's and
 * Mistral's own formats, Bedrock's and Vertex's signed requests, and
 * providers whose address depends on the user's settings (Azure,
 * Cloudflare) or on a subscription.
 */

/**
 * A provider API's wire format, named by its owner rather than by any
 * agent: how requests are authenticated, which paths they use, and where
 * the answer reports its usage.
 * - `anthropic_messages`: Anthropic's Messages API, `POST /v1/messages`,
 *   key in `x-api-key`.
 * - `openai_responses`: OpenAI's Responses API, `POST /responses`, key as a
 *   bearer token.
 * - `openai_chat_completions`: OpenAI's Chat Completions API, `POST
 *   /chat/completions`, key as a bearer token, which many providers serve.
 */
export type ProviderApiFormat =
  | "anthropic_messages"
  | "openai_responses"
  | "openai_chat_completions";

/** One API of a provider, at the address the agent would otherwise call. */
export type RelayedProviderApi = {
  format: ProviderApiFormat;
  /** The provider's own base URL for it, as the agent knows it, without a trailing slash. */
  upstreamBaseUrl: string;
};

export type RelayedProvider = {
  providerId: string;
  apis: readonly RelayedProviderApi[];
};

export const relayedProviders: readonly RelayedProvider[] = [
  {
    providerId: "anthropic",
    apis: [{ format: "anthropic_messages", upstreamBaseUrl: "https://api.anthropic.com" }],
  },
  {
    providerId: "openai",
    apis: [{ format: "openai_responses", upstreamBaseUrl: "https://api.openai.com/v1" }],
  },
  {
    providerId: "openrouter",
    apis: [
      { format: "anthropic_messages", upstreamBaseUrl: "https://openrouter.ai/api" },
      { format: "openai_chat_completions", upstreamBaseUrl: "https://openrouter.ai/api/v1" },
    ],
  },
  {
    providerId: "xai",
    apis: [{ format: "openai_responses", upstreamBaseUrl: "https://api.x.ai/v1" }],
  },
  {
    providerId: "deepseek",
    apis: [{ format: "openai_chat_completions", upstreamBaseUrl: "https://api.deepseek.com" }],
  },
  {
    providerId: "groq",
    apis: [
      { format: "openai_chat_completions", upstreamBaseUrl: "https://api.groq.com/openai/v1" },
    ],
  },
  {
    providerId: "cerebras",
    apis: [{ format: "openai_chat_completions", upstreamBaseUrl: "https://api.cerebras.ai/v1" }],
  },
  {
    providerId: "together",
    apis: [{ format: "openai_chat_completions", upstreamBaseUrl: "https://api.together.ai/v1" }],
  },
];

const relayedProvidersById = new Map(
  relayedProviders.map((provider) => [provider.providerId, provider]),
);

/** The provider's relayed APIs, or undefined when its key is placed in the sandbox instead. */
export function findRelayedProvider(providerId: string): RelayedProvider | undefined {
  return relayedProvidersById.get(providerId);
}

export function isRelayedProvider(providerId: string): boolean {
  return relayedProvidersById.has(providerId);
}
