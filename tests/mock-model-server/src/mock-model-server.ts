import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * A stand-in for an OpenAI-compatible model, so tests can run the real Pi
 * with no network and no API key. It streams chat completions as server-sent
 * events, the way Pi's `openai-completions` API expects:
 * https://platform.openai.com/docs/api-reference/chat-streaming
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
 *   OpenAI sends it), which Pi does not retry either;
 * - containing `RATE_LIMIT`: a rate limit error every time, which Pi retries
 *   until its retries run out;
 * - containing `OVERFLOW_ONCE`: a context overflow error the first time, so
 *   Pi compacts the conversation (when it has enough to compact) and retries;
 * - containing `REPLY_SLOWLY`: a long reply, one word every 100 ms, so a test
 *   can act while the agent is busy;
 * - anything else: "Hello there.".
 * A tool result gets the reply "Done.".
 *
 * Every request's credential (its `Authorization: Bearer` value) is
 * recorded, and a test can declare a credential's quota exhausted, so that
 * every request presenting it fails as `EXHAUST_QUOTA` does. The error
 * bodies are OpenAI's own, as its API documents them:
 * https://platform.openai.com/docs/guides/error-codes
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

type MockFailure = { statusCode: number; message: string; type?: string; code?: string };

const overloadedFailure: MockFailure = { statusCode: 503, message: "The model is overloaded." };
const invalidKeyFailure: MockFailure = {
  statusCode: 401,
  message: "Incorrect API key provided",
  type: "invalid_request_error",
  code: "invalid_api_key",
};
const exhaustedQuotaFailure: MockFailure = {
  statusCode: 429,
  message: "You exceeded your current quota, please check your plan and billing details.",
  type: "insufficient_quota",
  code: "insufficient_quota",
};
const rateLimitFailure: MockFailure = {
  statusCode: 429,
  message: "Rate limit reached for requests",
  type: "requests",
  code: "rate_limit_exceeded",
};
const contextOverflowFailure: MockFailure = {
  statusCode: 400,
  message: "Your input exceeds the context window of this model.",
};

export type ChatMessage = { role: string; content: unknown };

export type MockModelServer = {
  /** The `baseUrl` for Pi's models.json, ending in `/v1`. */
  baseUrl: string;
  port: number;
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

type ReceivedRequests = Pick<
  MockModelServer,
  "receivedConversations" | "receivedCredentials" | "receivedModels"
> & { exhaustedCredentials: Set<string> };

type ChunkWriter = (delta: object, finishReason: string | null) => void;
type ReplyWriter = { writeChunk: ChunkWriter; hasClientLeft: () => boolean };

/**
 * Listens on loopback unless given another local address, such as the one
 * Docker containers reach the host on.
 */
export async function startMockModelServer(host = "127.0.0.1"): Promise<MockModelServer> {
  const received: ReceivedRequests = {
    receivedConversations: [],
    receivedCredentials: [],
    receivedModels: [],
    exhaustedCredentials: new Set(),
  };
  const server = createServer((request, response) => {
    void answerRequest(request, response, received);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The mock model server is not listening on a TCP port.");
  }
  return {
    baseUrl: `http://${host}:${address.port}/v1`,
    port: address.port,
    receivedConversations: received.receivedConversations,
    receivedCredentials: received.receivedCredentials,
    receivedModels: received.receivedModels,
    exhaustQuotaOf: (credential) => received.exhaustedCredentials.add(credential),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function answerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  received: ReceivedRequests,
): Promise<void> {
  if (!request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  const body: { model: string; messages: ChatMessage[] } = JSON.parse(await readBody(request));
  const credential = readBearerCredential(request);
  received.receivedConversations.push(body.messages);
  received.receivedCredentials.push(credential);
  received.receivedModels.push(body.model);
  const failure =
    credential !== undefined && received.exhaustedCredentials.has(credential)
      ? exhaustedQuotaFailure
      : chooseFailure(body.messages, received.receivedConversations);
  if (failure !== undefined) {
    const { statusCode, ...error } = failure;
    response.writeHead(statusCode, { "content-type": "application/json" });
    response.end(JSON.stringify({ error }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const writeChunk: ChunkWriter = (delta, finishReason) => {
    const chunk = {
      id: "mock-completion",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  await writeReply(body.messages.at(-1), {
    writeChunk,
    hasClientLeft: () => response.destroyed,
  });
  response.end("data: [DONE]\n\n");
}

/** `receivedConversations` includes this request's. */
function chooseFailure(
  messages: ChatMessage[],
  receivedConversations: ChatMessage[][],
): MockFailure | undefined {
  const lastUserText = describeUserMessage(messages.at(-1));
  if (lastUserText.includes(mockModelTriggers.invalidKey)) {
    return invalidKeyFailure;
  }
  if (lastUserText.includes(mockModelTriggers.persistentFailure)) {
    return overloadedFailure;
  }
  if (lastUserText.includes(mockModelTriggers.exhaustedQuota)) {
    return exhaustedQuotaFailure;
  }
  if (lastUserText.includes(mockModelTriggers.rateLimit)) {
    return rateLimitFailure;
  }
  const isFirstRequestWith = (trigger: string) =>
    lastUserText.includes(trigger) &&
    receivedConversations.filter((conversation) =>
      describeUserMessage(conversation.at(-1)).includes(trigger),
    ).length === 1;
  if (isFirstRequestWith(mockModelTriggers.transientFailure)) {
    return overloadedFailure;
  }
  if (isFirstRequestWith(mockModelTriggers.contextOverflow)) {
    return contextOverflowFailure;
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
  replyWriter: ReplyWriter,
): Promise<void> {
  const lastUserText = describeUserMessage(lastMessage);
  const { writeChunk } = replyWriter;
  const commandRequest = readUserText(lastMessage);
  if (commandRequest.startsWith(mockModelTriggers.command)) {
    writeBashCall(writeChunk, commandRequest.slice(mockModelTriggers.command.length));
  } else if (lastUserText.includes(mockModelTriggers.toolExecution)) {
    writeBashCall(writeChunk, "echo hi");
  } else if (lastUserText.includes(mockModelTriggers.crash)) {
    writeBashCall(writeChunk, "kill -9 $PPID");
  } else if (lastUserText.includes(mockModelTriggers.slowReply)) {
    const words = Array.from({ length: slowReplyWordCount }, (_, index) => `word${index} `);
    await writeTextReply(replyWriter, words, slowReplyWordDelayInMilliseconds);
  } else {
    const words = lastMessage?.role === "tool" ? ["Done", "."] : ["Hello", " there."];
    await writeTextReply(replyWriter, words, 0);
  }
}

async function writeTextReply(
  { writeChunk, hasClientLeft }: ReplyWriter,
  words: string[],
  wordDelayInMilliseconds: number,
): Promise<void> {
  writeChunk({ role: "assistant", content: "" }, null);
  for (const word of words) {
    if (wordDelayInMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, wordDelayInMilliseconds));
    }
    if (hasClientLeft()) {
      return;
    }
    writeChunk({ content: word }, null);
  }
  writeChunk({}, "stop");
}

function writeBashCall(writeChunk: ChunkWriter, command: string): void {
  writeChunk({ role: "assistant", content: "Running it." }, null);
  writeChunk(
    {
      tool_calls: [
        { index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } },
      ],
    },
    null,
  );
  const commandArguments = JSON.stringify({ command });
  writeChunk({ tool_calls: [{ index: 0, function: { arguments: commandArguments } }] }, null);
  writeChunk({}, "tool_calls");
}

function readBearerCredential(request: IncomingMessage): string | undefined {
  const { authorization } = request.headers;
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
}
