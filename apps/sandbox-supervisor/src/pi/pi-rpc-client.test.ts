import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createSilentLogger } from "../test-support/silent-logger.js";
import { waitUntil } from "../test-support/wait-until.js";
import type { PiEvent, PiExtensionUiRequest } from "./pi-records.js";
import { PiCommandRejectedError, PiOutputEndedError, PiRpcClient } from "./pi-rpc-client.js";

/** Stands in for Pi: reads the commands the client writes and answers on its stdout. */
function createStubPi() {
  const commandStream = new PassThrough();
  const recordStream = new PassThrough();
  const events: PiEvent[] = [];
  const extensionUiRequests: PiExtensionUiRequest[] = [];
  const client = new PiRpcClient({
    commandStream,
    recordStream,
    logger: createSilentLogger(),
    onEvent: (event) => events.push(event),
    onExtensionUiRequest: (request) => extensionUiRequests.push(request),
  });
  const receivedCommands: Array<{ id: string; type: string }> = [];
  let unfinishedCommandText = "";
  commandStream.on("data", (chunk: Buffer) => {
    const lines = (unfinishedCommandText + chunk.toString()).split("\n");
    unfinishedCommandText = lines.pop() ?? "";
    receivedCommands.push(...lines.map((line) => JSON.parse(line)));
  });
  const writeRecord = (record: object) => recordStream.write(`${JSON.stringify(record)}\n`);
  return { client, receivedCommands, events, extensionUiRequests, writeRecord, recordStream };
}

describe("PiRpcClient", () => {
  it("matches responses to commands by identifier, whatever order they arrive in", async () => {
    const stub = createStubPi();

    const stateRequest = stub.client.send({ type: "get_state" });
    const queueRequest = stub.client.send({ type: "clear_queue" });
    await waitUntil(() => stub.receivedCommands.length === 2, "both commands are written");
    const [stateCommand, queueCommand] = stub.receivedCommands;
    stub.writeRecord({
      id: queueCommand?.id,
      type: "response",
      command: "clear_queue",
      success: true,
      data: { steering: [] },
    });
    stub.writeRecord({
      id: stateCommand?.id,
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionFile: "/s.jsonl" },
    });

    await expect(stateRequest).resolves.toEqual({ sessionFile: "/s.jsonl" });
    await expect(queueRequest).resolves.toEqual({ steering: [] });
  });

  it("writes each command as one JSON line with a fresh identifier", async () => {
    const stub = createStubPi();

    void stub.client.send({ type: "prompt", message: "hi", streamingBehavior: "steer" });
    void stub.client.send({ type: "abort" });
    await waitUntil(() => stub.receivedCommands.length === 2, "both commands are written");

    expect(stub.receivedCommands[0]).toEqual({
      id: expect.any(String),
      type: "prompt",
      message: "hi",
      streamingBehavior: "steer",
    });
    expect(stub.receivedCommands[0]?.id).not.toBe(stub.receivedCommands[1]?.id);
  });

  it("fails a command that Pi rejects, with Pi's reason", async () => {
    const stub = createStubPi();

    const promptRequest = stub.client.send({
      type: "prompt",
      message: "hi",
      streamingBehavior: "steer",
    });
    await waitUntil(() => stub.receivedCommands.length === 1, "the command is written");
    stub.writeRecord({
      id: stub.receivedCommands[0]?.id,
      type: "response",
      command: "prompt",
      success: false,
      error: "No API key found for the selected model.",
    });

    await expect(promptRequest).rejects.toEqual(
      new PiCommandRejectedError("prompt", "No API key found for the selected model."),
    );
  });

  it("fails pending commands when Pi's output ends, and refuses new ones", async () => {
    const stub = createStubPi();

    const abortRequest = stub.client.send({ type: "abort" });
    stub.recordStream.end();

    await expect(abortRequest).rejects.toBeInstanceOf(PiOutputEndedError);
    await expect(stub.client.send({ type: "get_state" })).rejects.toBeInstanceOf(
      PiOutputEndedError,
    );
  });

  it("passes events on and skips records it cannot use", async () => {
    const stub = createStubPi();

    stub.recordStream.write(
      'not json\n{"type":"queue_update","steering":[]}\n{"type":"agent_start"}\n',
    );
    stub.writeRecord({
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      title: "Sure?",
    });

    await waitUntil(() => stub.extensionUiRequests.length === 1, "the extension request arrives");
    expect(stub.events).toEqual([{ type: "agent_start" }]);
    expect(stub.extensionUiRequests[0]).toMatchObject({ id: "ui-1", method: "confirm" });
  });
});
