import type { ConfigureModelAccess, ProxyTokenCredential } from "@barrack/protocol";
import type { TestControlPlane } from "./test-control-plane.js";
import type { FakeSupervisor } from "./test-peers.js";

/**
 * What a sandbox's agent does with the model proxy, as a test plays it: the
 * proxy token and address its supervisor was told, and requests in each
 * relayed format, shaped as the agent's own clients send them.
 */

export type ProxyAccess = { token: string; basePath: string; providerId: string };

/** The newest proxy token the supervisor was told, with the path it is for. */
export async function waitForProxyAccess(
  supervisor: FakeSupervisor,
  providerId: string,
): Promise<ProxyAccess> {
  const message = await supervisor.inbox.waitFor(
    `a model proxy token for ${providerId}`,
    (candidate) =>
      candidate.type === "configure_model_access" &&
      candidate.credential?.kind === "proxy_token" &&
      candidate.model?.startsWith(`${providerId}/`) === true,
  );
  const credential = (message as ConfigureModelAccess).credential as ProxyTokenCredential;
  return {
    token: credential.secret,
    basePath: new URL(credential.baseUrl).pathname,
    providerId,
  };
}

export type RelayedFormatExample = {
  providerId: string;
  apiPath: string;
  /** How the agent's client presents its credential. */
  credentialHeaders: (token: string) => Record<string, string>;
  body: (text: string) => object;
};

export const relayedFormatExamples = {
  anthropic: {
    providerId: "anthropic",
    apiPath: "/v1/messages?beta=true",
    credentialHeaders: (token) => ({ "x-api-key": token, "anthropic-version": "2023-06-01" }),
    body: (text) => ({
      model: "claude-test",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    }),
  },
  openai: {
    providerId: "openai",
    apiPath: "/responses",
    credentialHeaders: (token) => ({ authorization: `Bearer ${token}` }),
    body: (text) => ({
      model: "gpt-test",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text }] }],
    }),
  },
  groq: {
    providerId: "groq",
    apiPath: "/chat/completions",
    credentialHeaders: (token) => ({ authorization: `Bearer ${token}` }),
    body: (text) => ({
      model: "llama-test",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: text }],
    }),
  },
} as const satisfies Record<string, RelayedFormatExample>;

export type ProxyRequestOptions = {
  method?: string;
  apiPath?: string;
  headers?: Record<string, string>;
  body?: RequestInit["body"];
  signal?: AbortSignal;
};

/** Sends a request to the model proxy as the agent would, in `example`'s format. */
export function callModelProxy(
  controlPlane: TestControlPlane,
  access: ProxyAccess,
  example: RelayedFormatExample,
  text: string,
  options: ProxyRequestOptions = {},
): Promise<Response> {
  return fetch(
    `${controlPlane.httpBaseUrl}${access.basePath}${options.apiPath ?? example.apiPath}`,
    {
      method: options.method ?? "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...example.credentialHeaders(access.token),
        ...options.headers,
      },
      body: options.body ?? JSON.stringify(example.body(text)),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      // Node's fetch needs `duplex` to send a body as a stream; the DOM's
      // RequestInit type, which TypeScript uses here, does not know it.
      ...(options.body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit,
  );
}
