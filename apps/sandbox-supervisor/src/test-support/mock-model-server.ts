import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * A stand-in for an OpenAI-compatible model on 127.0.0.1, so tests can run
 * the real Pi with no network and no API key. It streams chat completions as
 * server-sent events, the way Pi's `openai-completions` API expects:
 * https://platform.openai.com/docs/api-reference/chat-streaming
 *
 * What it says depends on the newest user message:
 * - containing `RUN_TOOL`: a `bash` tool call that runs `echo hi`;
 * - containing `CRASH_AGENT`: a `bash` tool call that kills Pi, the shell's
 *   parent process, to test recovery from a crash;
 * - anything else: "Hello there.".
 * A tool result gets the reply "Done.".
 */
export const mockModelTriggers = { toolExecution: "RUN_TOOL", crash: "CRASH_AGENT" } as const;

export type ChatMessage = { role: string; content: unknown };

export type MockModelServer = {
  /** The `baseUrl` for Pi's models.json, ending in `/v1`. */
  baseUrl: string;
  /** The messages of every request received, oldest request first. */
  receivedConversations: ChatMessage[][];
  close(): Promise<void>;
};

type ChunkWriter = (delta: object, finishReason: string | null) => void;

export async function startMockModelServer(): Promise<MockModelServer> {
  const receivedConversations: ChatMessage[][] = [];
  const server = createServer((request, response) => {
    void answerRequest(request, response, receivedConversations);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The mock model server is not listening on a TCP port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    receivedConversations,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function answerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  receivedConversations: ChatMessage[][],
): Promise<void> {
  if (!request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  const body: { model: string; messages: ChatMessage[] } = JSON.parse(await readBody(request));
  receivedConversations.push(body.messages);
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
  writeReply(body.messages.at(-1), writeChunk);
  response.end("data: [DONE]\n\n");
}

function writeReply(lastMessage: ChatMessage | undefined, writeChunk: ChunkWriter): void {
  const lastUserText = lastMessage?.role === "user" ? JSON.stringify(lastMessage.content) : "";
  if (lastUserText.includes(mockModelTriggers.toolExecution)) {
    writeBashCall(writeChunk, "echo hi");
  } else if (lastUserText.includes(mockModelTriggers.crash)) {
    writeBashCall(writeChunk, "kill -9 $PPID");
  } else {
    writeTextReply(writeChunk, lastMessage?.role === "tool" ? ["Done", "."] : ["Hello", " there."]);
  }
}

function writeTextReply(writeChunk: ChunkWriter, words: string[]): void {
  writeChunk({ role: "assistant", content: "" }, null);
  for (const word of words) {
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

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
}
