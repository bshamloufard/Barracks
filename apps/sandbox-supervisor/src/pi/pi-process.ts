import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { Logger } from "../logger.js";
import { LineSplitter } from "./line-splitter.js";
import type { PiEvent, PiExtensionUiRequest } from "./pi-records.js";
import { PiRpcClient } from "./pi-rpc-client.js";

export type PiLaunchSettings = {
  /** Pi's RPC-mode entry point, run with the supervisor's own Node. */
  entryPointPath: string;
  workspaceDirectory: string;
  sessionDirectory: string;
  /** Names the session on first launch, so it can be found again. */
  sessionId: string;
  /** Reopens this session file instead, when it exists. */
  sessionFileToResume: string | undefined;
  model: string;
  environment: NodeJS.ProcessEnv;
};

export type PiExit = {
  /** True when the supervisor asked Pi to stop. */
  wasRequested: boolean;
  description: string;
  /** The end of what Pi wrote to stderr, to explain an unexpected exit. */
  recentDiagnostics: string;
};

export type PiProcessHandlers = {
  onEvent: (event: PiEvent) => void;
  onExtensionUiRequest: (request: PiExtensionUiRequest) => void;
  onExit: (exit: PiExit) => void;
};

/**
 * How long Pi gets to shut down after its stdin closes. Pi treats end of
 * input as an orderly shutdown that still writes its last events; a signal
 * cuts the event stream off, so it is only the fallback.
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
 */
const gracefulExitTimeoutInMilliseconds = 5_000;
const terminatedExitTimeoutInMilliseconds = 3_000;
const recentDiagnosticsMaximumLength = 2_000;

export function buildPiArguments(settings: PiLaunchSettings): string[] {
  // `--session-id` is looked up relative to the working directory, so the
  // session file path is the more reliable way to reopen a session.
  const sessionArguments =
    settings.sessionFileToResume === undefined
      ? ["--session-dir", settings.sessionDirectory, "--session-id", settings.sessionId]
      : ["--session", settings.sessionFileToResume];
  return [
    settings.entryPointPath,
    ...sessionArguments,
    "--model",
    settings.model,
    // Trust the repository's own Pi configuration. Untrusted settings would
    // otherwise be skipped silently in RPC mode; the sandbox is the boundary.
    "--approve",
  ];
}

export class PiProcess {
  readonly client: PiRpcClient;
  readonly #child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly #logger: Logger;
  readonly #exited: Promise<void>;
  #recentDiagnostics = "";
  #isStopRequested = false;
  #hasExited = false;

  constructor(settings: PiLaunchSettings, handlers: PiProcessHandlers, logger: Logger) {
    this.#logger = logger;
    this.#child = spawn(process.execPath, buildPiArguments(settings), {
      cwd: settings.workspaceDirectory,
      env: settings.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.client = new PiRpcClient({
      commandStream: this.#child.stdin,
      recordStream: this.#child.stdout,
      logger,
      onEvent: handlers.onEvent,
      onExtensionUiRequest: handlers.onExtensionUiRequest,
    });
    this.#recordDiagnostics(this.#child.stderr);
    this.#exited = this.#watchForExit(handlers.onExit);
    logger.info({ processId: this.#child.pid }, "Started Pi");
  }

  get hasExited(): boolean {
    return this.#hasExited;
  }

  get recentDiagnostics(): string {
    return this.#recentDiagnostics;
  }

  /** Closes Pi's input and waits for it to exit, escalating to signals if it does not. */
  async stop(): Promise<void> {
    if (this.#hasExited) {
      return;
    }
    this.#isStopRequested = true;
    this.#child.stdin.end();
    if (await this.#waitForExit(gracefulExitTimeoutInMilliseconds)) {
      return;
    }
    this.#logger.warn("Pi did not exit after its input closed; sending SIGTERM");
    this.#child.kill("SIGTERM");
    if (await this.#waitForExit(terminatedExitTimeoutInMilliseconds)) {
      return;
    }
    this.#logger.warn("Pi did not exit after SIGTERM; sending SIGKILL");
    this.#child.kill("SIGKILL");
    await this.#exited;
  }

  #waitForExit(timeoutInMilliseconds: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutInMilliseconds);
      void this.#exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Resolves once Pi has exited and its output has been read to the end, so
   * every event it wrote is handled before the exit is reported. A process
   * that could not be spawned at all reports through `error` instead.
   */
  #watchForExit(onExit: (exit: PiExit) => void): Promise<void> {
    return new Promise((resolve) => {
      const reportExit = (description: string) => {
        if (this.#hasExited) {
          return;
        }
        this.#hasExited = true;
        onExit({
          wasRequested: this.#isStopRequested,
          description,
          recentDiagnostics: this.#recentDiagnostics,
        });
        resolve();
      };
      this.#child.on("close", (exitCode, signal) => {
        reportExit(`Pi exited with ${signal === null ? `code ${exitCode}` : `signal ${signal}`}.`);
      });
      this.#child.on("error", (error) => {
        reportExit(`Pi could not be run: ${error.message}`);
      });
    });
  }

  /**
   * Pi writes diagnostics to stderr, never protocol records. They are logged
   * and the most recent kept, to explain a crash to the user.
   */
  #recordDiagnostics(diagnosticStream: Readable): void {
    const lineSplitter = new LineSplitter();
    diagnosticStream.on("data", (chunk: Buffer) => {
      for (const line of lineSplitter.push(chunk)) {
        this.#logger.info({ diagnostic: line }, "Pi wrote a diagnostic");
        this.#recentDiagnostics = `${this.#recentDiagnostics}${line}\n`.slice(
          -recentDiagnosticsMaximumLength,
        );
      }
    });
  }
}
