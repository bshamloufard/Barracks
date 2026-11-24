import { access, constants } from "node:fs/promises";
import { userInfo } from "node:os";
import type { AgentProcessLauncher } from "./agent-process-launcher.js";
import { defaultRunAsAgentPath, runAsAgent } from "./run-as-agent.js";
import { SameUserAgentLauncher } from "./same-user-agent-launcher.js";
import { SeparateUserAgentLauncher } from "./separate-user-agent-launcher.js";
import { lookUpUserAccount, type UserAccount } from "./user-account.js";

export type AgentUserSettings = {
  /** `BARRACK_AGENT_USER`: the user the agent runs as. */
  agentUserName: string | undefined;
  /**
   * `BARRACK_AGENT_SHARES_SUPERVISOR_USER=development-only`: the agent may
   * run as the supervisor's own user, as the local-process provider needs.
   */
  agentMayShareSupervisorUser: boolean;
  /** Directories the agent must be able to write to, checked at startup. */
  agentDirectories: readonly string[];
  runAsAgentPath?: string;
};

export type LauncherPreparation =
  | { ok: true; launcher: AgentProcessLauncher }
  | { ok: false; problems: string[] };

/**
 * Prints, as JSON, the user and group IDs it runs with, whether it may still
 * gain privileges, and each directory, of those named in its arguments, that
 * it cannot create files in.
 */
const describeAgentProcessScript = `
const { accessSync, constants, readFileSync } = require("node:fs");
const unwritableDirectories = process.argv.slice(1).filter((directory) => {
  try { accessSync(directory, constants.W_OK | constants.X_OK); return false; } catch { return true; }
});
const noNewPrivileges = /^NoNewPrivs:\\s*1$/m.test(readFileSync("/proc/self/status", "utf8"));
console.log(JSON.stringify({
  userId: process.getuid(), groupId: process.getgid(), groups: process.getgroups(),
  noNewPrivileges, unwritableDirectories,
}));`;

const howToShareForDevelopment =
  "For local development only, where the agent may read it, set BARRACK_AGENT_SHARES_SUPERVISOR_USER=development-only instead.";

const unsetAgentUserProblem = `BARRACK_AGENT_USER: is not set, so the agent would run as this supervisor's own user and could read the supervisor's token. Set it to the agent's own user (barrack-agent in Barrack's sandbox image, which sets it unless the platform does not pass the image's environment on). ${howToShareForDevelopment}`;

/**
 * Chooses how the agent is launched, and when it is to run as a separate
 * user, checks once at startup everything that launching it needs, so a
 * misconfigured sandbox fails with a clear message rather than on the first
 * user message. The check runs a real process as the agent, through the
 * same helper and Node the agent will use, so it also catches a sandbox
 * that cannot change user at all (missing capabilities, or
 * `no-new-privileges`).
 *
 * An agent running as the supervisor's own user can read the supervisor's
 * token from the supervisor's environment in `/proc`, and with it act as
 * the thread's supervisor. That would happen silently whenever the agent
 * user is missing (a platform that does not pass the image's environment to
 * the supervisor) or is the supervisor's own (a sandbox started with its
 * user overridden), so it is allowed only when chosen by name.
 */
export async function prepareAgentProcessLauncher(
  settings: AgentUserSettings,
): Promise<LauncherPreparation> {
  const { agentUserName } = settings;
  if (agentUserName === undefined) {
    return shareSupervisorUserIfChosen(settings, unsetAgentUserProblem);
  }
  if (agentUserName === findCurrentUserName()) {
    return shareSupervisorUserIfChosen(settings, describeAgentUserIsOwnUser(agentUserName));
  }
  const lookup = await lookUpUserAccount(agentUserName);
  if (!lookup.found) {
    return { ok: false, problems: [`BARRACK_AGENT_USER: ${lookup.reason}`] };
  }
  if (lookup.account.userId === process.getuid?.()) {
    return shareSupervisorUserIfChosen(settings, describeAgentUserIsOwnUser(agentUserName));
  }
  const runAsAgentPath = settings.runAsAgentPath ?? defaultRunAsAgentPath;
  const problems = await checkRunningAsAgent(runAsAgentPath, lookup.account, settings);
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, launcher: new SeparateUserAgentLauncher(lookup.account, runAsAgentPath) };
}

function describeAgentUserIsOwnUser(agentUserName: string): string {
  return `BARRACK_AGENT_USER: "${agentUserName}" is the user this supervisor runs as, so the agent could read the supervisor's token. Run the supervisor as a user of its own (barrack-supervisor in Barrack's sandbox image; check that the sandbox was not started with its user overridden). ${howToShareForDevelopment}`;
}

function shareSupervisorUserIfChosen(
  settings: AgentUserSettings,
  problemOtherwise: string,
): LauncherPreparation {
  return settings.agentMayShareSupervisorUser
    ? { ok: true, launcher: new SameUserAgentLauncher() }
    : { ok: false, problems: [problemOtherwise] };
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
  const outcome = await runAsAgent(runAsAgentPath, [
    process.execPath,
    "-e",
    describeAgentProcessScript,
    ...settings.agentDirectories,
  ]);
  if (outcome.exitCode !== 0) {
    return [
      `BARRACK_AGENT_USER: ${runAsAgentPath} could not run a process as "${account.name}" (exit code ${outcome.exitCode}: ${outcome.standardError.trim()}). The sandbox must keep the SETUID and SETGID capabilities and must not set no-new-privileges.`,
    ];
  }
  const agentProcess = parseAgentProcess(outcome.standardOutput);
  if (agentProcess === undefined) {
    return [`BARRACK_AGENT_USER: ${runAsAgentPath} ran a process whose report could not be read`];
  }
  return [
    ...describeIdentityProblems(runAsAgentPath, account, agentProcess),
    ...agentProcess.unwritableDirectories.map(
      (directory) =>
        `${directory}: must exist and be writable by the agent's user "${account.name}"`,
    ),
  ];
}

type AgentProcessReport = {
  userId: number;
  groupId: number;
  groups: number[];
  noNewPrivileges: boolean;
  unwritableDirectories: string[];
};

function parseAgentProcess(standardOutput: string): AgentProcessReport | undefined {
  try {
    return JSON.parse(standardOutput) as AgentProcessReport;
  } catch {
    return undefined;
  }
}

/**
 * The helper decides the user by itself, so the user it made must be the
 * one `BARRACK_AGENT_USER` names, with that user's group alone, and unable
 * to gain privileges: an image whose helper and users disagree must not
 * start an agent that is someone else.
 */
function describeIdentityProblems(
  runAsAgentPath: string,
  account: UserAccount,
  agentProcess: AgentProcessReport,
): string[] {
  const isAgent =
    agentProcess.userId === account.userId &&
    agentProcess.groupId === account.groupId &&
    agentProcess.groups.every((group) => group === account.groupId);
  const problems: string[] = [];
  if (!isAgent) {
    problems.push(
      `BARRACK_AGENT_USER: ${runAsAgentPath} runs processes as user ${agentProcess.userId}, group ${agentProcess.groupId} (groups ${agentProcess.groups.join(",")}), not as "${account.name}" (${account.userId}, group ${account.groupId} alone); the helper and the image's users disagree`,
    );
  }
  if (!agentProcess.noNewPrivileges) {
    problems.push(
      `BARRACK_AGENT_USER: ${runAsAgentPath} leaves the agent able to gain privileges (no_new_privs is not set); it is not Barrack's helper`,
    );
  }
  return problems;
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
