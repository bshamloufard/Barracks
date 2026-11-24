import { execFile } from "node:child_process";
import path from "node:path";

/**
 * Where the sandbox image installs `run-as-agent`: a small program of
 * Barrack's own (sandbox-image/run-as-agent.c) that carries the setuid and
 * setgid file capabilities, only the supervisor's group may run, and can
 * make its caller `barrack-agent` and no one else. See
 * sandbox-image/README.md.
 */
export const defaultRunAsAgentPath = "/opt/barrack/bin/run-as-agent";

/**
 * The arguments that make `run-as-agent` run `command` as the agent: the
 * program, by its absolute path, and its arguments, nothing more. Which
 * user, group and groups the command gets is fixed in the helper, which
 * also drops every capability and sets no_new_privs before it executes
 * the command in its own place, so the process that results has the
 * helper's process ID and can never gain a privilege.
 */
export function buildRunAsAgentArguments(command: readonly string[]): string[] {
  const [program] = command;
  if (program === undefined || !path.isAbsolute(program)) {
    throw new Error(
      `run-as-agent runs a program only by its absolute path, not "${program ?? ""}"`,
    );
  }
  return [...command];
}

export type CommandOutcome = { exitCode: number; standardOutput: string; standardError: string };

/**
 * Runs a short command as the agent and collects what it printed. It gets an
 * empty environment: a process running as the agent's user shows its
 * environment to the agent, so the supervisor's own must never be passed on.
 */
export function runAsAgent(
  runAsAgentPath: string,
  command: readonly string[],
): Promise<CommandOutcome> {
  return new Promise((resolve, reject) => {
    execFile(
      runAsAgentPath,
      buildRunAsAgentArguments(command),
      { env: {}, cwd: "/", timeout: 30_000 },
      (error, standardOutput, standardError) => {
        if (error === null) {
          resolve({ exitCode: 0, standardOutput, standardError });
          return;
        }
        // A number is the command's exit code; anything else means it could
        // not be run or did not finish (a spawn error, a timeout).
        if (typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ exitCode: error.code, standardOutput, standardError });
      },
    );
  });
}
