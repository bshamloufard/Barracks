import type { Readable } from "node:stream";
import type {
  AgentProcessLauncher,
  AgentProcessStdio,
  LaunchedAgentProcess,
} from "../agent-process/agent-process-launcher.js";
import { finishesWithin } from "../finishes-within.js";
import type { Logger } from "../logger.js";
import { LineSplitter } from "./line-splitter.js";
import type { PiEvent, PiExtensionUiRequest } from "./pi-records.js";
import { PiRpcClient } from "./pi-rpc-client.js";
import type { PiStopTiming } from "./pi-stop-timing.js";

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
  /** Pi extensions to load besides any the workspace configures, such as the computer tool. */
  extensionPaths: readonly string[];
  environment: NodeJS.ProcessEnv;
  /** Decides which operating-system user Pi runs as. */
  launcher: AgentProcessLauncher;
  stopTiming: PiStopTiming;
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

const recentDiagnosticsMaximumLength = 2_000;

/**
 * Diagnostics are human-readable lines, logged one by one, and only the last
 * couple of thousand characters are ever shown to the user. Something that
 * writes to stderr without ever ending its line (a progress indicator redrawn
 * with `\r`, a stray binary dump) would otherwise grow the held line without
 * limit, so a line is cut after this many bytes; its start says what it is.
 */
const diagnosticLineMaximumLengthInBytes = 16 * 1024;

export function buildPiArguments(settings: PiLaunchSettings): string[] {
  // `--session-id` is looked up relative to the working directory, so the
  // session file path is the more reliable way to reopen a session.
  const sessionArguments =
    settings.sessionFileToResume === undefined
      ? ["--session-dir", settings.sessionDirectory, "--session-id", settings.sessionId]
      : ["--session", settings.sessionFileToResume];
  return [
    ...sessionArguments,
    "--model",
    settings.model,
    ...settings.extensionPaths.flatMap((extensionPath) => ["--extension", extensionPath]),
    // Trust the repository's own Pi configuration. Untrusted settings would
    // otherwise be skipped silently in RPC mode; the sandbox is the boundary.
    // A repository's own extensions can then rewrite Pi's requests (Pi's
    // provider hooks); for a provider the control plane relays, its model
    // proxy refuses any request not shaped like the pinned Pi's own.
    "--approve",
  ];
}

export class PiProcess {
  readonly client: PiRpcClient;
  readonly #agentProcess: LaunchedAgentProcess;
  readonly #child: AgentProcessStdio;
  readonly #stopTiming: PiStopTiming;
  readonly #logger: Logger;
  readonly #exited: Promise<void>;
  #recentDiagnostics = "";
  #isStopRequested = false;
  #hasExited = false;
  #stopped: Promise<void> | undefined;

  constructor(settings: PiLaunchSettings, handlers: PiProcessHandlers, logger: Logger) {
    this.#logger = logger;
    this.#stopTiming = settings.stopTiming;
    this.#agentProcess = settings.launcher.launch({
      scriptPath: settings.entryPointPath,
      scriptArguments: buildPiArguments(settings),
      workingDirectory: settings.workspaceDirectory,
      environment: settings.environment,
    });
    this.#child = this.#agentProcess.child;
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

  /**
   * Closes Pi's input and waits for it to exit, escalating to signals sent to
   * every process of the agent if it does not. Every wait is bounded, so a
   * stop always finishes. Stopping again while a stop is under way waits for
   * that same stop.
   */
  stop(): Promise<void> {
    this.#stopped ??= this.#stopInStages();
    return this.#stopped;
  }

  async #stopInStages(): Promise<void> {
    if (this.#hasExited) {
      return;
    }
    const timing = this.#stopTiming;
    this.#isStopRequested = true;
    this.#child.stdin.end();
    if (await finishesWithin(this.#exited, timing.gracefulExitTimeoutInMilliseconds)) {
      return;
    }
    this.#logger.warn("Pi did not exit after its input closed; sending SIGTERM to the agent");
    await this.#signalAgentProcesses("SIGTERM");
    if (await finishesWithin(this.#exited, timing.terminatedExitTimeoutInMilliseconds)) {
      return;
    }
    this.#logger.warn("Pi did not exit after SIGTERM; sending SIGKILL to the agent");
    await this.#signalAgentProcesses("SIGKILL");
    if (await finishesWithin(this.#exited, timing.killedExitTimeoutInMilliseconds)) {
      return;
    }
    this.#logger.error(
      { processId: this.#child.pid },
      "Pi's process has still not ended after SIGKILL; no longer waiting for it",
    );
  }

  async #signalAgentProcesses(signal: NodeJS.Signals): Promise<void> {
    try {
      await this.#agentProcess.signalAgentProcesses(signal);
    } catch (error) {
      this.#logger.error({ err: error, signal }, "Signalling the agent's processes failed");
    }
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
    const lineSplitter = new LineSplitter({
      maximumLineLengthInBytes: diagnosticLineMaximumLengthInBytes,
    });
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
