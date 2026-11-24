import type { Writable } from "node:stream";
import type { AgentProcessLauncher } from "../agent-process/agent-process-launcher.js";

/**
 * Runs Git in the agent's workspace, as the agent. The repository is the
 * agent's to change (its configuration, hooks, filters), so Git is never run
 * in it with the supervisor's privileges: whatever the repository makes Git
 * run, it runs as the agent, which can run anything already.
 *
 * Git gets an environment built from an allowlist, never the supervisor's,
 * which holds the supervisor's token, and messages in English, so failures
 * read the same everywhere. No credential is ever put in it: Git asks the
 * credential helper (see `git-credential-helper.ts`) when it needs one.
 */

/** What Git needs from the supervisor's environment: where programs are, and a proxy if there is one. */
const passedVariableNames = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

/** Enough of Git's messages to say why it failed, without holding a huge output. */
const maximumCapturedOutputLength = 64 * 1024;

export type GitOutcome = { exitCode: number | null; standardOutput: string; standardError: string };

export type GitRunOptions = {
  timeoutInMilliseconds: number;
  /** Where standard output goes instead of being captured, such as a bundle's file. */
  standardOutput?: Writable;
};

export class AgentGit {
  readonly #launcher: AgentProcessLauncher;
  readonly #workspaceDirectory: string;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(
    launcher: AgentProcessLauncher,
    workspaceDirectory: string,
    sourceEnvironment: NodeJS.ProcessEnv,
  ) {
    this.#launcher = launcher;
    this.#workspaceDirectory = workspaceDirectory;
    this.#environment = buildGitEnvironment(sourceEnvironment);
  }

  get workspaceDirectory(): string {
    return this.#workspaceDirectory;
  }

  run(gitArguments: readonly string[], options: GitRunOptions): Promise<GitOutcome> {
    return this.runProgram("git", gitArguments, options);
  }

  /** Runs any program as the agent in the workspace, under the same rules as Git. */
  runProgram(
    executable: string,
    programArguments: readonly string[],
    options: GitRunOptions,
  ): Promise<GitOutcome> {
    return new Promise((resolve, reject) => {
      // The program runs as the agent, whom the supervisor may not signal,
      // so its time limit is kept by a watchdog that runs as the agent too.
      const child = this.#launcher.launchCommand({
        executable: process.execPath,
        arguments: [
          "-e",
          watchdogScript,
          String(options.timeoutInMilliseconds),
          executable,
          ...programArguments,
        ],
        workingDirectory: this.#workspaceDirectory,
        environment: this.#environment,
      });
      child.stdin.end();
      let standardOutput = "";
      let standardError = "";
      if (options.standardOutput === undefined) {
        child.stdout.on("data", (chunk: Buffer) => {
          standardOutput = appendCapped(standardOutput, chunk);
        });
      } else {
        child.stdout.pipe(options.standardOutput);
      }
      child.stderr.on("data", (chunk: Buffer) => {
        standardError = appendCapped(standardError, chunk);
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({
          exitCode: exitCode === timedOutExitCode ? null : exitCode,
          standardOutput,
          standardError,
        });
      });
    });
  }
}

/** What the watchdog exits with when it had to stop the program; `timeout(1)` uses the same. */
const timedOutExitCode = 124;

/**
 * Runs the program given after its time limit, passing its output through
 * and exiting as it did, or kills it once the limit has passed.
 */
const watchdogScript = `
const { spawn } = require("node:child_process");
const [limit, command, ...commandArguments] = process.argv.slice(1);
const program = spawn(command, commandArguments, { stdio: "inherit" });
const timer = setTimeout(() => { program.kill("SIGKILL"); process.exit(${timedOutExitCode}); }, Number(limit));
program.on("error", (error) => { process.stderr.write(error.message + "\\n"); process.exit(127); });
program.on("exit", (code) => { clearTimeout(timer); process.exit(code ?? 1); });
`;

export function buildGitEnvironment(sourceEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of passedVariableNames) {
    const value = sourceEnvironment[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    LC_ALL: "C",
    // Git must fail rather than wait for someone to type a password.
    GIT_TERMINAL_PROMPT: "0",
  };
}

function appendCapped(captured: string, chunk: Buffer): string {
  return captured.length >= maximumCapturedOutputLength
    ? captured
    : (captured + chunk.toString()).slice(0, maximumCapturedOutputLength);
}
