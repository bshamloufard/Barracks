import { spawn } from "node:child_process";
import type {
  AgentCommandRequest,
  AgentLaunchRequest,
  AgentProcessLauncher,
  AgentProcessStdio,
  LaunchedAgentProcess,
} from "./agent-process-launcher.js";
import { buildRunAsAgentArguments, runAsAgent } from "./run-as-agent.js";
import type { UserAccount } from "./user-account.js";

/**
 * Sends the signal named in its argument to every process the calling user
 * may signal: `kill(-1)` reaches all of them except the caller itself.
 * https://man7.org/linux/man-pages/man2/kill.2.html
 */
const signalEveryProcessOfThisUserScript =
  'try { process.kill(-1, process.argv[1]); } catch (error) { if (error.code !== "ESRCH") throw error; }';

/**
 * Runs the agent as its own unprivileged user, through `run-as-agent`, so
 * that it cannot read the supervisor's memory, signal it, or trace it:
 * Linux allows those only between processes of the same user. The helper
 * can make its caller that one user and no other; `account` is the user it
 * is known to make (checked at startup), for the variables naming the user.
 *
 * The same rule means the supervisor cannot signal the agent either, so
 * signals are sent by a short process that runs as the agent. Signalling
 * every process of the agent's user, rather than a tree, also reaches
 * commands that left the tree (a daemon, a process in a new session); in a
 * sandbox, everything running as that user is the agent's.
 */
export class SeparateUserAgentLauncher implements AgentProcessLauncher {
  readonly description: string;
  readonly #account: UserAccount;
  readonly #runAsAgentPath: string;

  constructor(account: UserAccount, runAsAgentPath: string) {
    this.#account = account;
    this.#runAsAgentPath = runAsAgentPath;
    this.description = `the separate user "${account.name}"`;
  }

  launch(request: AgentLaunchRequest): LaunchedAgentProcess {
    const command = [process.execPath, request.scriptPath, ...request.scriptArguments];
    // Node changes into the working directory before it executes the
    // helper, still as the supervisor, which therefore needs search access
    // to it (see sandbox-image/README.md).
    const child = spawn(this.#runAsAgentPath, buildRunAsAgentArguments(command), {
      cwd: request.workingDirectory,
      env: { ...request.environment, ...this.#describeUser() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { child, signalAgentProcesses: (signal) => this.#signalEveryAgentProcess(signal) };
  }

  launchCommand(request: AgentCommandRequest): AgentProcessStdio {
    const command = [request.executable, ...request.arguments];
    return spawn(this.#runAsAgentPath, buildRunAsAgentArguments(command), {
      cwd: request.workingDirectory,
      env: { ...request.environment, ...this.#describeUser() },
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  /** `run-as-agent` leaves the environment alone, so these would still name the supervisor's user. */
  #describeUser(): NodeJS.ProcessEnv {
    return {
      HOME: this.#account.homeDirectory,
      USER: this.#account.name,
      LOGNAME: this.#account.name,
      SHELL: this.#account.loginShell,
    };
  }

  async #signalEveryAgentProcess(signal: NodeJS.Signals): Promise<void> {
    const outcome = await runAsAgent(this.#runAsAgentPath, [
      process.execPath,
      "-e",
      signalEveryProcessOfThisUserScript,
      signal,
    ]);
    if (outcome.exitCode !== 0) {
      throw new Error(
        `Sending ${signal} to the processes of "${this.#account.name}" failed with exit code ${outcome.exitCode}: ${outcome.standardError.trim()}`,
      );
    }
  }
}
