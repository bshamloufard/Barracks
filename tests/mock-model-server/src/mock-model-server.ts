import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { planDesktopReply, type ScriptedReply } from "./desktop-scripts.js";
import {
  type ChatMessage,
  createReplyWriter,
  describeUsage,
  type MockFailureKind,
  type MockUsage,
  type ReplyWriter,
  readConversation,
  readCredential,
  type WireFormat,
  wireFormatOf,
  writeFailure,
} from "./wire-formats.js";

export { desktopTestPageColours, desktopTriggers } from "./desktop-scripts.js";
export type { ChatMessage, MockUsage, WireFormat } from "./wire-formats.js";

/**
 * A stand-in for a model provider, so tests can run the real Pi with no
 * network and no API key. It speaks three providers' wire formats (see
 * `wire-formats.ts`), told apart by path: OpenAI's Chat Completions
 * (`…/chat/completions`), Anthropic's Messages (`…/v1/messages`) and
 * OpenAI's Responses (`…/responses`), streaming each answer as that
 * provider does, with its usage.
 *
 * What it says depends on the newest user message:
 * - containing `RUN_TOOL`: a `bash` tool call that runs `echo hi`;
 * - starting `RUN_COMMAND `: a `bash` tool call that runs the rest of the
 *   message, so a test can see what the agent's own commands can do;
 * - containing `CRASH_AGENT`: a `bash` tool call that kills Pi, the shell's
 *   parent process, to test recovery from a crash;
 * - containing `FAIL_ONCE`: an "overloaded" error the first time, which Pi
 *   retries, and the usual reply after that;
 * - containing `FAIL_ALWAYS`: an "overloaded" error every time, so Pi's
 *   retries run out;
 * - containing `REJECT_KEY`: an invalid key error, which Pi does not retry;
 * - containing `EXHAUST_QUOTA`: an exhausted quota error (status 429, as
 *   OpenAI sends it; Anthropic's credit message with 400), which Pi does
 *   not retry either;
 * - containing `RATE_LIMIT`: a rate limit error every time, which Pi retries
 *   until its retries run out;
 * - containing `OVERFLOW_ONCE`: a context overflow error the first time, so
 *   Pi compacts the conversation (when it has enough to compact) and retries;
 * - containing `REPLY_SLOWLY`: a long reply, one word every 100 ms, so a test
 *   can act while the agent is busy;
 * - anything else: "Hello there.".
 * The agent's computer tool has scripts of its own (`desktop-scripts.ts`),
 * in the Chat Completions format. A tool result gets the reply "Done.".
 *
 * Every request is recorded: its format, path, credential (`x-api-key` or
 * `Authorization: Bearer`), model, headers, and the usage its answer
 * reported. A test can declare a credential's quota exhausted, so that
 * every request presenting it fails as `EXHAUST_QUOTA` does.
 */
export const mockModelTriggers = {
  toolExecution: "RUN_TOOL",
  command: "RUN_COMMAND ",
  crash: "CRASH_AGENT",
  transientFailure: "FAIL_ONCE",
  persistentFailure: "FAIL_ALWAYS",
  invalidKey: "REJECT_KEY",
  exhaustedQuota: "EXHAUST_QUOTA",
  rateLimit: "RATE_LIMIT",
  contextOverflow: "OVERFLOW_ONCE",
  slowReply: "REPLY_SLOWLY",
} as const;

const slowReplyWordCount = 50;
const slowReplyWordDelayInMilliseconds = 100;

/** One request as the mock received it, and how it answered. */
export type ReceivedModelRequest = {
  format: WireFormat;
  /** The path and query it was sent to. */
  target: string;
  credential: string | undefined;
  model: string;
  /** Every header, by lower-case name. */
  headers: Record<string, string | string[] | undefined>;
  conversation: ChatMessage[];
  /** What its answer reported using, in Barrack's terms; undefined if it failed or was cut off. */
  usage: MockUsage | undefined;
  /** Whether the client hung up before the answer ended. */
  wasAbandoned: boolean;
};

export type MockModelServer = {
  /** The `baseUrl` for Pi's models.json, ending in `/v1`. */
  baseUrl: string;
  /** `http://host:port`, for pointing the model proxy at the mock. */
  origin: string;
  port: number;
  /** Every request received, oldest first. */
  receivedRequests: ReceivedModelRequest[];
  /** The messages of every request received, oldest request first. */
  receivedConversations: ChatMessage[][];
  /** The credential each of those requests presented, or undefined for none. */
  receivedCredentials: Array<string | undefined>;
  /** The model each of those requests named. */
  receivedModels: string[];
  /** Makes every later request presenting `credential` fail as out of quota. */
  exhaustQuotaOf(credential: string): void;
  close(): Promise<void>;
};

type ReceivedState = {
  requests: ReceivedModelRequest[];
  exhaustedCredentials: Set<string>;
};

/**
 * Listens on loopback unless given another local address, such as the one
 * Docker containers reach the host on.
 */
export async function startMockModelServer(host = "127.0.0.1"): Promise<MockModelServer> {
  const state: ReceivedState = { requests: [], exhaustedCredentials: new Set() };
  const server = createServer((request, response) => {
    void answerRequest(request, response, state);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The mock model server is not listening on a TCP port.");
  }
  const origin = `http://${host}:${address.port}`;
  return {
    baseUrl: `${origin}/v1`,
    origin,
    port: address.port,
    receivedRequests: state.requests,
    get receivedConversations() {
      return state.requests.map((request) => request.conversation);
    },
    get receivedCredentials() {
      return state.requests.map((request) => request.credential);
    },
    get receivedModels() {
      return state.requests.map((request) => request.model);
    },
    exhaustQuotaOf: (credential) => state.exhaustedCredentials.add(credential),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function answerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: ReceivedState,
): Promise<void> {
  const format = wireFormatOf(request.url);
  if (format === undefined || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.parse(await readBody(request));
  const conversation = readConversation(format, body);
  const received: ReceivedModelRequest = {
    format,
    target: request.url ?? "",
    credential: readCredential(request),
    model: body.model,
    headers: { ...request.headers },
    conversation,
    usage: undefined,
    wasAbandoned: false,
  };
  state.requests.push(received);
  const failure = chooseFailure(received, state);
  if (failure !== undefined) {
    writeFailure(response, format, failure);
    return;
  }
  const writer = createReplyWriter(format, response, body.model, (outputPieces) =>
    describeUsage(format, conversation, outputPieces),
  );
  const desktopReply = format === "chat_completions" ? planDesktopReply(conversation) : undefined;
  const endReason =
    desktopReply === undefined
      ? await writeReply(conversation.at(-1), writer)
      : writeScriptedReply(desktopReply, writer, conversation.length);
  if (endReason === "abandoned") {
    received.wasAbandoned = true;
    return;
  }
  writer.finish(endReason);
  received.usage = describeUsage(format, conversation, writer.outputPieces);
}

/** `state.requests` includes this request. */
function chooseFailure(
  received: ReceivedModelRequest,
  state: ReceivedState,
): MockFailureKind | undefined {
  if (received.credential !== undefined && state.exhaustedCredentials.has(received.credential)) {
    return "exhausted_quota";
  }
  const lastUserText = describeUserMessage(received.conversation.at(-1));
  if (lastUserText.includes(mockModelTriggers.invalidKey)) {
    return "invalid_key";
  }
  if (lastUserText.includes(mockModelTriggers.persistentFailure)) {
    return "overloaded";
  }
  if (lastUserText.includes(mockModelTriggers.exhaustedQuota)) {
    return "exhausted_quota";
  }
  if (lastUserText.includes(mockModelTriggers.rateLimit)) {
    return "rate_limit";
  }
  const isFirstRequestWith = (trigger: string) =>
    lastUserText.includes(trigger) &&
    state.requests.filter((request) =>
      describeUserMessage(request.conversation.at(-1)).includes(trigger),
    ).length === 1;
  if (isFirstRequestWith(mockModelTriggers.transientFailure)) {
    return "overloaded";
  }
  if (isFirstRequestWith(mockModelTriggers.contextOverflow)) {
    return "context_overflow";
  }
  return undefined;
}

function describeUserMessage(message: ChatMessage | undefined): string {
  return message?.role === "user" ? JSON.stringify(message.content) : "";
}

/** The text of a user message, whether it came as a string or as content parts. */
function readUserText(message: ChatMessage | undefined): string {
  if (message?.role !== "user") {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
    )
    .join("");
}

async function writeReply(
  lastMessage: ChatMessage | undefined,
  writer: ReplyWriter,
): Promise<"stop" | "tool_use" | "abandoned"> {
  const lastUserText = describeUserMessage(lastMessage);
  const commandRequest = readUserText(lastMessage);
  if (commandRequest.startsWith(mockModelTriggers.command)) {
    return writeBashCall(writer, commandRequest.slice(mockModelTriggers.command.length));
  }
  if (lastUserText.includes(mockModelTriggers.toolExecution)) {
    return writeBashCall(writer, "echo hi");
  }
  if (lastUserText.includes(mockModelTriggers.crash)) {
    return writeBashCall(writer, "kill -9 $PPID");
  }
  if (lastUserText.includes(mockModelTriggers.slowReply)) {
    const words = Array.from({ length: slowReplyWordCount }, (_, index) => `word${index} `);
    return writeTextReply(writer, words, slowReplyWordDelayInMilliseconds);
  }
  const words = lastMessage?.role === "tool" ? ["Done", "."] : ["Hello", " there."];
  return writeTextReply(writer, words, 0);
}

async function writeTextReply(
  writer: ReplyWriter,
  words: string[],
  wordDelayInMilliseconds: number,
): Promise<"stop" | "abandoned"> {
  for (const word of words) {
    if (wordDelayInMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, wordDelayInMilliseconds));
    }
    if (writer.hasClientLeft()) {
      return "abandoned";
    }
    writer.writeText(word);
  }
  return "stop";
}

function writeBashCall(writer: ReplyWriter, command: string): "tool_use" {
  writer.writeToolCall({
    text: "Running it.",
    toolName: "bash",
    toolArguments: { command },
    toolCallId: "call_1",
  });
  return "tool_use";
}

/** A step of a desktop script; each tool call is named after its place in the conversation. */
function writeScriptedReply(
  reply: ScriptedReply,
  writer: ReplyWriter,
  conversationLength: number,
): "stop" | "tool_use" {
  if (reply.kind === "text") {
    writer.writeText(reply.text);
    return "stop";
  }
  writer.writeToolCall({ ...reply, toolCallId: `call_${conversationLength}` });
  return "tool_use";
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
}
