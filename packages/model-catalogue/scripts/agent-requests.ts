import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodingTools, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type ProviderApiFormat,
  type RelayedProvider,
  relayedProviders,
} from "../src/relayed-providers.js";

/**
 * Builds the requests the pinned Pi sends to each relayed provider, through
 * Pi's own code, as the sandbox's Pi would send them to the model proxy:
 * every model Pi lists for a relayed provider, each with its provider's
 * address replaced by a model proxy address in Pi's `models.json` (as the
 * sandbox supervisor writes it, which is what decides some of what Pi sends:
 * Anthropic's message threads, say, only at Anthropic's own address), at
 * every thinking level and every prompt cache retention Pi uses, for
 * conversations shaped like the coding agent's: its tools and the desktop's
 * computer tool, text, screenshots in tool results (an error's too) and in
 * a user's message, thinking shown and redacted, an answer cut short, tool
 * calls answered, the tools changing mid-conversation, and an earlier
 * answer from another model after a switch; and the requests it makes
 * besides a turn (a compaction's summary, a cache refresh). Each request is
 * caught at the HTTP client, its method, path below the provider's address,
 * query, headers and bytes as they would be sent, and answered with an
 * error, so nothing leaves the process.
 */

export type AgentRequest = {
  providerId: string;
  format: ProviderApiFormat;
  modelId: string;
  /** What varied, for a reader of a failure. */
  variant: string;
  method: string;
  /** Below the provider's address, which here is the model proxy's (`/v1/messages`, say). */
  path: string;
  /** The query string, without its `?`. */
  query: string;
  headers: Record<string, string>;
  body: string;
};

/** Pi's own names for the formats the proxy relays. */
const formatOfPiApi: Readonly<Record<string, ProviderApiFormat>> = {
  "anthropic-messages": "anthropic_messages",
  "openai-responses": "openai_responses",
  "openai-completions": "openai_chat_completions",
};

/** Every thinking level Pi offers (`undefined` is off), and the cache retentions it uses. */
const thinkingLevels = [undefined, "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const cacheRetentions = ["short", "long", "none"] as const;

/** A token as the proxy mints them: 43 characters of base64url, none of a real key's prefixes. */
const proxyToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** A one-pixel PNG: the shape of a screenshot is what matters here, not its size. */
const imageData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type RuntimeModel = ReturnType<ModelRuntime["getModels"]>[number];
type StreamOptions = NonNullable<Parameters<ModelRuntime["streamSimple"]>[2]>;
type StreamContext = Parameters<ModelRuntime["streamSimple"]>[1];

/** Builds every request; `onRequest` receives each as it is caught. */
export async function buildAgentRequests(
  onRequest: (request: AgentRequest) => void,
): Promise<void> {
  const scratchDirectory = await mkdtemp(path.join(tmpdir(), "barrack-agent-requests-"));
  try {
    const modelsPath = path.join(scratchDirectory, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: proxiedProviders() }));
    const runtime = await ModelRuntime.create({
      authPath: path.join(scratchDirectory, "auth.json"),
      modelsPath,
      modelsStorePath: path.join(scratchDirectory, "models-store.json"),
      refreshOnCreate: false,
    });
    for (const provider of relayedProviders) {
      for (const model of runtime.getModels(provider.providerId)) {
        await buildModelRequests(runtime, provider, model, onRequest);
      }
    }
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

/** What the sandbox supervisor writes into Pi's `models.json`: the proxy's address for each relayed provider. */
function proxiedProviders(): Record<string, { baseUrl: string }> {
  return Object.fromEntries(
    relayedProviders.map(({ providerId }) => [providerId, { baseUrl: proxyAddress(providerId) }]),
  );
}

function proxyAddress(providerId: string): string {
  return `http://control-plane.invalid/threads/00000000-0000-4000-8000-000000000000/model-proxy/${providerId}`;
}

async function buildModelRequests(
  runtime: ModelRuntime,
  provider: RelayedProvider,
  model: RuntimeModel,
  onRequest: (request: AgentRequest) => void,
): Promise<void> {
  const format = formatOfPiApi[model.api];
  if (format === undefined) {
    throw new Error(`${provider.providerId}/${model.id} speaks ${model.api}, which is not relayed`);
  }
  const conversations = buildConversations(model);
  for (const reasoning of thinkingLevels) {
    for (const cacheRetention of cacheRetentions) {
      for (const [name, context] of Object.entries(conversations)) {
        const variant = `${name}, thinking ${reasoning ?? "off"}, cache ${cacheRetention}`;
        await send(runtime, provider, model, context, { reasoning, cacheRetention }, (caught) =>
          onRequest({
            providerId: provider.providerId,
            format,
            modelId: model.id,
            variant,
            ...caught,
          }),
        );
      }
      // A refresh of the prompt cache: the same request, with a one-token output (`cache-warmer.js`).
      await send(
        runtime,
        provider,
        model,
        conversations.longConversation,
        { reasoning, cacheRetention, maxTokens: 1, disableContinuation: true },
        (caught) =>
          onRequest({
            providerId: provider.providerId,
            format,
            modelId: model.id,
            variant: `cache refresh, thinking ${reasoning ?? "off"}, cache ${cacheRetention}`,
            ...caught,
          }),
      );
    }
  }
}

/** Sends one request through Pi, catching it at the HTTP client. */
async function send(
  runtime: ModelRuntime,
  provider: RelayedProvider,
  model: RuntimeModel,
  context: StreamContext,
  options: {
    reasoning: (typeof thinkingLevels)[number];
    cacheRetention: (typeof cacheRetentions)[number];
    maxTokens?: number;
    disableContinuation?: boolean;
  },
  onCaught: (caught: Omit<AgentRequest, "providerId" | "format" | "modelId" | "variant">) => void,
): Promise<void> {
  const capture: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const proxy = new URL(proxyAddress(provider.providerId));
    const isToProxy = url.origin === proxy.origin && url.pathname.startsWith(`${proxy.pathname}/`);
    onCaught({
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      // A request sent anywhere else keeps its whole address, which no route matches.
      path: isToProxy ? url.pathname.slice(proxy.pathname.length) : url.href,
      query: url.search.slice(1),
      headers: readHeaders(init?.headers),
      body: String(init?.body ?? ""),
    });
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "caught" },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  };
  const events = runtime.streamSimple(model, context, {
    ...options,
    apiKey: proxyToken,
    sessionId: "019a0000-0000-7000-8000-000000000000",
    maxRetries: 0,
    fetch: capture,
  } as StreamOptions);
  for await (const _event of events) {
    // Drained only so the request completes; the error it ends with is expected.
  }
}

function readHeaders(headers: unknown): Record<string, string> {
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries((headers ?? {}) as Record<string, string>);
  return Object.fromEntries(entries.map(([name, value]) => [name.toLowerCase(), String(value)]));
}

type ToolDefinition = { name: string; description: string; parameters: unknown };

/** The coding agent's own tools, the desktop's computer tool, and a tool of the user's own with a grammar. */
function buildTools(): ToolDefinition[] {
  const codingTools = createCodingTools(process.cwd()).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...("constrainedSampling" in tool ? { constrainedSampling: tool.constrainedSampling } : {}),
  }));
  return [
    ...codingTools,
    {
      name: "computer",
      description: "Use the desktop: take a screenshot, move and click the mouse, type.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["screenshot", "left_click", "type", "key"] },
          coordinate: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          text: { type: "string" },
        },
        required: ["action"],
      },
    },
    {
      name: "apply_patch",
      description: "A tool of the user's own whose input follows a grammar.",
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
      constrainedSampling: { type: "grammar", variants: { openai_lark: 'start: "patch"' } },
    } as ToolDefinition,
  ];
}

/** How each format signs its thinking, as Pi keeps it from an answer of the provider's. */
function thinkingSignatureFor(model: RuntimeModel): string {
  switch (model.api) {
    case "openai-responses":
      // The reasoning item as the provider returned it; Pi sends it back as it stands.
      return JSON.stringify({
        id: "rs_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Thinking." }],
        content: [{ type: "reasoning_text", text: "Thinking." }],
        encrypted_content: "e".repeat(64),
        status: "completed",
      });
    case "openai-completions":
      return model.provider === "openrouter"
        ? JSON.stringify([
            { type: "reasoning.text", text: "Thinking.", format: "unknown", index: 0 },
            { type: "reasoning.encrypted", data: "e".repeat(64), id: "r1", format: "unknown" },
          ])
        : "reasoning_content";
    default:
      return "s".repeat(64);
  }
}

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The conversations each model is asked about, in Pi's transcript form. */
type Conversations = Record<
  "firstTurn" | "longConversation" | "toolsChanging" | "summary",
  StreamContext
>;

function buildConversations(model: RuntimeModel): Conversations {
  const tools = buildTools();
  const [firstTool, ...laterTools] = tools;
  const system = (content: string, extra: object) => ({
    role: "system",
    content,
    timestamp: 0,
    ...extra,
  });
  const user = (content: unknown) => ({ role: "user", content, timestamp: 1 });
  const assistant = (content: unknown[], from: Partial<RuntimeModel> = model) => ({
    role: "assistant",
    content,
    api: from.api,
    provider: from.provider,
    model: from.id,
    // The effort Pi noted for an earlier answer of this model's, which it
    // restates before that answer to the models that take it mid-conversation.
    ...(from === model ? { providerThinkingLevel: "high" } : {}),
    usage,
    stopReason: "toolUse",
    timestamp: 2,
  });
  const toolResult = (id: string, name: string, content: unknown[], isError = false) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content,
    isError,
    timestamp: 3,
  });
  const image = { type: "image", data: imageData, mimeType: "image/png" };
  const signature = thinkingSignatureFor(model);
  const textSignature =
    model.api === "openai-responses"
      ? JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" })
      : undefined;
  const call = (id: string, name: string, args: object) => ({
    type: "toolCall",
    id: model.api === "openai-responses" ? `${id}|fc_${id}` : id,
    name,
    arguments: args,
  });
  const turns = [
    user([{ type: "text", text: "Please fix the failing test." }, image]),
    assistant([
      { type: "thinking", thinking: "Let me look.", thinkingSignature: signature },
      { type: "text", text: "I will read the file.", ...(textSignature ? { textSignature } : {}) },
      call("call_1", "read", { path: "src/a.ts" }),
    ]),
    toolResult("call_1", "read", [{ type: "text", text: "export const a = 1;" }]),
    assistant([
      { type: "thinking", thinking: "", thinkingSignature: signature, redacted: true },
      call("call_2", "computer", { action: "screenshot" }),
      call("call_3", "apply_patch", { input: "patch" }),
    ]),
    toolResult("call_2", "computer", [{ type: "text", text: "Here it is." }, image]),
    toolResult("call_3", "apply_patch", [{ type: "text", text: "Failed." }, image], true),
    // An answer cut short: its thinking never signed.
    assistant([{ type: "thinking", thinking: "Half a thought", thinkingSignature: "" }]),
    // An answer from the model before a switch.
    assistant(
      [
        { type: "thinking", thinking: "Elsewhere.", thinkingSignature: "x" },
        { type: "text", text: "Done there." },
        call("call_4", "bash", { command: "ls" }),
      ],
      {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "another-model",
      } as Partial<RuntimeModel>,
    ),
    toolResult("call_4", "bash", [{ type: "text", text: "a.ts" }]),
    user("Carry on."),
  ];
  return {
    firstTurn: {
      messages: [system("You are a coding agent.", { toolsAdded: tools }), user("Hello")],
    },
    longConversation: {
      messages: [system("You are a coding agent.", { toolsAdded: tools }), ...turns],
    },
    toolsChanging: {
      messages: [
        system("You are a coding agent.", { toolsAdded: [firstTool] }),
        user("Start."),
        assistant([{ type: "text", text: "Started." }]),
        system("Tools changed.", {
          toolsAdded: laterTools,
          toolsRemoved: firstTool === undefined ? [] : [{ name: firstTool.name }],
        }),
        ...turns,
      ],
    },
    // A compaction's summary: no tools, its own prompt (`compaction.js`).
    summary: {
      messages: [system("Summarise the conversation.", {}), user("The conversation so far.")],
    },
  } as unknown as Conversations;
}
