import { access, constants } from "node:fs/promises";
import { userInfo } from "node:os";
import type { AgentProcessLauncher } from "./agent-process-launcher.js";
import { defaultRunAsAgentPath, runAsAgent } from "./run-as-agent.js";
import { SameUserAgentLauncher } from "./same-user-agent-launcher.js";
import { SeparateUserAgentLauncher } from "./separate-user-agent-launcher.js";
import { lookUpUserAccount, type UserAccount } from "./user-account.js";

export type AgentUserSettings = {
  /** `BARRACK_AGENT_USER`: the user the agent should run as, if not the supervisor's own. */
  agentUserName: string | undefined;
  /** Directories the agent must be able to write to, checked at startup. */
  agentDirectories: readonly string[];
  runAsAgentPath?: string;
};

export type LauncherPreparation =
  | { ok: true; launcher: AgentProcessLauncher }
  | { ok: false; problems: string[] };

/**
 * Prints each directory, of those named in its arguments, that the calling
 * user cannot create files in.
 */
const listUnwritableDirectoriesScript = `
const { accessSync, constants } = require("node:fs");
for (const directory of process.argv.slice(1)) {
  try { accessSync(directory, constants.W_OK | constants.X_OK); } catch { console.log(directory); }
}`;

/**
 * Chooses how the agent is launched, and when it is to run as a separate
 * user, checks once at startup everything that launching it needs, so a
 * misconfigured sandbox fails with a clear message rather than on the first
 * user message. The check runs a real process as the agent, through the
 * same helper and Node the agent will use, so it also catches a sandbox
 * that cannot change user at all (missing capabilities, or
 * `no-new-privileges`).
 */
export async function prepareAgentProcessLauncher(
  settings: AgentUserSettings,
): Promise<LauncherPreparation> {
  const { agentUserName } = settings;
  if (agentUserName === undefined || agentUserName === findCurrentUserName()) {
    return { ok: true, launcher: new SameUserAgentLauncher() };
  }
  const lookup = await lookUpUserAccount(agentUserName);
  if (!lookup.found) {
    return { ok: false, problems: [`BARRACK_AGENT_USER: ${lookup.reason}`] };
  }
  if (lookup.account.userId === process.getuid?.()) {
    return { ok: true, launcher: new SameUserAgentLauncher() };
  }
  const runAsAgentPath = settings.runAsAgentPath ?? defaultRunAsAgentPath;
  const problems = await checkRunningAsAgent(runAsAgentPath, lookup.account, settings);
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, launcher: new SeparateUserAgentLauncher(lookup.account, runAsAgentPath) };
}

async function checkRunningAsAgent(
  runAsAgentPath: string,
  account: UserAccount,
  settings: AgentUserSettings,
): Promise<string[]> {
  try {
    await access(runAsAgentPath, constants.X_OK);
  } catch {
    return [
      `BARRACK_AGENT_USER: the helper ${runAsAgentPath}, which starts the agent as "${account.name}", is missing or this user may not run it`,
    ];
  }
  const outcome = await runAsAgent(runAsAgentPath, account, [
    process.execPath,
    "-e",
    listUnwritableDirectoriesScript,
    ...settings.agentDirectories,
  ]);
  if (outcome.exitCode !== 0) {
    return [
      `BARRACK_AGENT_USER: ${runAsAgentPath} could not run a process as "${account.name}" (exit code ${outcome.exitCode}: ${outcome.standardError.trim()}). The sandbox must keep the SETUID and SETGID capabilities and must not set no-new-privileges.`,
    ];
  }
  return outcome.standardOutput
    .split("\n")
    .filter((directory) => directory.length > 0)
    .map(
      (directory) =>
        `${directory}: must exist and be writable by the agent's user "${account.name}"`,
    );
}

/** Undefined when the current user has no entry in the password database. */
function findCurrentUserName(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    // A container started with an arbitrary user ID has no name for it;
    // the agent's account is then compared by ID instead.
    return undefined;
  }
}
