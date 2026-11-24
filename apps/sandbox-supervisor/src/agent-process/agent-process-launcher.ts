import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * The one place that knows which operating-system user the agent runs as.
 * A harness asks for a Node.js script to be run and gets back the running
 * process; whether that process is the supervisor's own user or a separate,
 * unprivileged one is the launcher's business alone.
 */
export interface AgentProcessLauncher {
  /** Says who the agent runs as, for the supervisor's log. */
  readonly description: string;

  launch(request: AgentLaunchRequest): LaunchedAgentProcess;
}

export type AgentLaunchRequest = {
  /** A Node.js script, run with the supervisor's own Node. */
  scriptPath: string;
  scriptArguments: readonly string[];
  workingDirectory: string;
  /**
   * The agent's environment. The launcher sets the variables that name the
   * user (`HOME`, `USER`, `LOGNAME`, `SHELL`) to the user the agent runs as.
   */
  environment: NodeJS.ProcessEnv;
};

export type AgentProcessStdio = ChildProcessByStdio<Writable, Readable, Readable>;

export type LaunchedAgentProcess = {
  /** The agent's process, with its standard input, output and error piped to the supervisor. */
  child: AgentProcessStdio;
  /**
   * Sends a signal to the agent's process and to every process it started,
   * including those in process groups of their own (Pi starts each command
   * in one). Resolves once the signals are sent, not once the processes end.
   */
  signalAgentProcesses(signal: NodeJS.Signals): Promise<void>;
};
