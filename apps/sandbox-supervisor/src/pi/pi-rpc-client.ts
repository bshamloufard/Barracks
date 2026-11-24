import type { Readable, Writable } from "node:stream";
import type { Logger } from "../logger.js";
import { LineSplitter } from "./line-splitter.js";
import {
  type PiEvent,
  type PiExtensionUiRequest,
  type PiResponse,
  parsePiRecord,
} from "./pi-records.js";

/**
 * Talks to Pi over its RPC mode: one JSON command per line on stdin, and on
 * stdout one record per line, either a response to a command or an event.
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
 *
 * Pi bundles a client of its own, but it gives up on any command after 30
 * seconds, and `abort` only answers once the agent is idle, which can take
 * longer. Commands here wait as long as Pi is alive, and fail as soon as its
 * output ends.
 */

/** The commands the supervisor sends that Pi answers with a response. */
export type PiCommand =
  | { type: "get_state" }
  | { type: "prompt"; message: string; streamingBehavior: "steer" | "followUp" }
  | { type: "clear_queue" }
  | { type: "abort" };

/** Answers an extension's dialog. Pi sends no response to it. */
export type PiExtensionUiResponse = { type: "extension_ui_response"; id: string; cancelled: true };

export class PiCommandRejectedError extends Error {
  constructor(
    readonly commandType: PiCommand["type"],
    readonly reason: string,
  ) {
    super(`Pi rejected the ${commandType} command: ${reason}`);
    this.name = "PiCommandRejectedError";
  }
}

export class PiOutputEndedError extends Error {
  constructor(readonly commandType: PiCommand["type"]) {
    super(`Pi's output ended before it answered the ${commandType} command.`);
    this.name = "PiOutputEndedError";
  }
}

export type PiRpcClientOptions = {
  /** Pi's stdin. */
  commandStream: Writable;
  /** Pi's stdout. */
  recordStream: Readable;
  logger: Logger;
  onEvent: (event: PiEvent) => void;
  onExtensionUiRequest: (request: PiExtensionUiRequest) => void;
};

type PendingCommand = {
  commandType: PiCommand["type"];
  resolve: (responseData: unknown) => void;
  reject: (error: Error) => void;
};

export class PiRpcClient {
  readonly #options: PiRpcClientOptions;
  readonly #lineSplitter = new LineSplitter();
  readonly #pendingCommands = new Map<string, PendingCommand>();
  #nextCommandNumber = 1;
  #hasOutputEnded = false;

  constructor(options: PiRpcClientOptions) {
    this.#options = options;
    options.recordStream.on("data", (chunk: Buffer) => this.#receive(chunk));
    options.recordStream.on("end", () => this.#endOutput());
    options.recordStream.on("close", () => this.#endOutput());
    // Writing to a Pi that has just exited fails with EPIPE. Its pending
    // commands are failed when its output ends, so the write error only
    // needs recording here.
    options.commandStream.on("error", (error) => {
      options.logger.warn({ err: error }, "Writing a command to Pi failed");
    });
  }

  /**
   * Sends a command and resolves with the `data` of Pi's response. Commands
   * are matched to responses by identifier, because Pi answers them in the
   * order they finish, not the order they were sent.
   */
  send(command: PiCommand): Promise<unknown> {
    if (this.#hasOutputEnded) {
      return Promise.reject(new PiOutputEndedError(command.type));
    }
    const commandId = `barrack-${this.#nextCommandNumber++}`;
    return new Promise((resolve, reject) => {
      this.#pendingCommands.set(commandId, { commandType: command.type, resolve, reject });
      this.#write({ id: commandId, ...command });
    });
  }

  sendWithoutResponse(message: PiExtensionUiResponse): void {
    this.#write(message);
  }

  #write(message: object): void {
    this.#options.commandStream.write(`${JSON.stringify(message)}\n`);
  }

  #receive(chunk: Buffer): void {
    for (const line of this.#lineSplitter.push(chunk)) {
      this.#handleLine(line);
    }
  }

  #handleLine(line: string): void {
    const parsed = parsePiRecord(line);
    if (!parsed.ok) {
      this.#options.logger.warn({ reason: parsed.errorMessage }, "Ignoring a record from Pi");
      return;
    }
    const record = parsed.value;
    switch (record.kind) {
      case "response":
        this.#settleCommand(record.response);
        return;
      case "event":
        this.#options.onEvent(record.event);
        return;
      case "extension_ui_request":
        this.#options.onExtensionUiRequest(record.request);
        return;
      case "unrecognized":
        this.#options.logger.debug(
          { recordType: record.type },
          "Ignoring a Pi record of unknown type",
        );
        return;
    }
  }

  #settleCommand(response: PiResponse): void {
    const pendingCommand =
      response.id === undefined ? undefined : this.#pendingCommands.get(response.id);
    if (response.id === undefined || pendingCommand === undefined) {
      // Pi answers a line it could not parse with a response that has no identifier.
      this.#options.logger.warn(
        { command: response.command, reason: response.error },
        "Pi sent a response that matches no pending command",
      );
      return;
    }
    this.#pendingCommands.delete(response.id);
    if (response.success) {
      pendingCommand.resolve(response.data);
    } else {
      pendingCommand.reject(
        new PiCommandRejectedError(pendingCommand.commandType, response.error ?? "no reason given"),
      );
    }
  }

  #endOutput(): void {
    if (this.#hasOutputEnded) {
      return;
    }
    this.#hasOutputEnded = true;
    if (this.#lineSplitter.unfinishedLineLength > 0) {
      this.#options.logger.warn(
        { byteCount: this.#lineSplitter.unfinishedLineLength },
        "Pi's output ended in the middle of a record",
      );
    }
    for (const pendingCommand of this.#pendingCommands.values()) {
      pendingCommand.reject(new PiOutputEndedError(pendingCommand.commandType));
    }
    this.#pendingCommands.clear();
  }
}
