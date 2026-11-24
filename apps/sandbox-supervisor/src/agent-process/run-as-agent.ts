import { execFile } from "node:child_process";
import type { UserAccount } from "./user-account.js";

/**
 * Where the sandbox image installs `run-as-agent`: a copy of `setpriv` that
 * carries the setuid and setgid file capabilities and that only the
 * supervisor's group may run. See sandbox-image/README.md.
 */
export const defaultRunAsAgentPath = "/opt/barrack/bin/run-as-agent";

/**
 * The arguments that make `run-as-agent` run `command` as `account`: its
 * user, group and supplementary groups (`--init-groups`), so the command
 * keeps none of the supervisor's. `setpriv` then executes the command in
 * its own place, so the process that results has the helper's process ID,
 * and no capabilities, since the command's file carries none.
 * https://man7.org/linux/man-pages/man1/setpriv.1.html
 */
export function buildRunAsAgentArguments(
  account: UserAccount,
  command: readonly string[],
): string[] {
  return [
    `--reuid=${account.userId}`,
    `--regid=${account.groupId}`,
    "--init-groups",
    "--",
    ...command,
  ];
}

export type CommandOutcome = { exitCode: number; standardOutput: string; standardError: string };

/**
 * Runs a short command as the agent and collects what it printed. It gets an
 * empty environment: a process running as the agent's user shows its
 * environment to the agent, so the supervisor's own (and its token) must
 * never be passed on.
 */
export function runAsAgent(
  runAsAgentPath: string,
  account: UserAccount,
  command: readonly string[],
): Promise<CommandOutcome> {
  return new Promise((resolve, reject) => {
    execFile(
      runAsAgentPath,
      buildRunAsAgentArguments(account, command),
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
