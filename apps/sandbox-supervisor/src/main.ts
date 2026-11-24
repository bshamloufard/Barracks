import type { AgentProcessLauncher } from "./agent-process/agent-process-launcher.js";
import { prepareAgentProcessLauncher } from "./agent-process/prepare-agent-process-launcher.js";
import { SameUserAgentLauncher } from "./agent-process/same-user-agent-launcher.js";
import { type AgentHarnessConfiguration, readConfiguration } from "./configuration.js";
import { createLogger } from "./logger.js";
import { getPiDirectories } from "./pi/pi-installation.js";
import { SecretRedactor } from "./secret-redactor.js";
import { Supervisor } from "./supervisor.js";
import { readSupervisorSecrets } from "./supervisor-secrets.js";

/**
 * The exit code with which the supervisor refuses to start: `EX_CONFIG`
 * from sysexits.h. Sandbox providers read it as a sandbox that will fail the
 * same way however often it is started, until its configuration is fixed.
 */
const refusedToStartExitCode = 78;

/**
 * Why the supervisor stops goes to standard error as well as the log, as
 * its last words: providers show them to the user (Docker's reads the
 * container's standard error), while the log goes to standard output.
 */
function exitWithProblems(problems: readonly string[]): never {
  const problemList = problems.map((problem) => `  - ${problem}`).join("\n");
  process.stderr.write(
    `The sandbox supervisor cannot start: its configuration is invalid.\n${problemList}\n`,
  );
  process.exit(refusedToStartExitCode);
}

/** The fake agent is not a process, so only Pi needs a launcher that is checked. */
async function prepareLauncher(
  agentHarness: AgentHarnessConfiguration,
): Promise<AgentProcessLauncher> {
  if (agentHarness.kind === "fake") {
    return new SameUserAgentLauncher();
  }
  const { agentDirectory, sessionDirectory } = getPiDirectories(agentHarness.stateDirectory);
  const preparation = await prepareAgentProcessLauncher({
    agentUserName: agentHarness.agentUserName,
    agentMayShareSupervisorUser: agentHarness.agentMayShareSupervisorUser,
    agentDirectories: [agentHarness.workspaceDirectory, agentDirectory, sessionDirectory],
  });
  if (!preparation.ok) {
    exitWithProblems(preparation.problems);
  }
  return preparation.launcher;
}

const configurationResult = readConfiguration(process.env);
if (!configurationResult.ok) {
  exitWithProblems(configurationResult.problems);
}
const { supervisorSecretsDirectory, ...configurationFromEnvironment } =
  configurationResult.configuration;
const secretsResult = await readSupervisorSecrets(supervisorSecretsDirectory);
if (!secretsResult.ok) {
  exitWithProblems(secretsResult.problems);
}

const configuration = {
  ...configurationFromEnvironment,
  supervisorToken: secretsResult.secrets.supervisorToken,
};
const agentProcessLauncher = await prepareLauncher(configuration.agentHarness);
const secretRedactor = new SecretRedactor();
const logger = createLogger(configuration.logLevel, configuration.threadId, secretRedactor);
let isShuttingDown = false;

const supervisor = new Supervisor({
  configuration,
  // Pi's environment is built from an allowlist of this one. The token is
  // not in it anyway: it was read from a file. Whether the agent could still
  // read it from this process's memory depends on the user it runs as;
  // src/pi/pi-environment.ts says exactly what is protected.
  sourceEnvironment: process.env,
  agentProcessLauncher,
  logger,
  secretRedactor,
  onFatalError: (error) => void shutDown(1, error.message),
});

async function shutDown(exitCode: number, reason: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  logger.info({ reason, exitCode }, "Shutting down");
  if (exitCode !== 0) {
    process.stderr.write(`The sandbox supervisor stopped: ${secretRedactor.redactText(reason)}\n`);
  }
  try {
    await supervisor.stop();
  } catch (error) {
    logger.error({ err: error }, "Shutting down did not finish cleanly");
    process.exit(1);
  }
  process.exit(exitCode);
}

process.once("SIGINT", () => void shutDown(0, "received SIGINT"));
process.once("SIGTERM", () => void shutDown(0, "received SIGTERM"));

logger.info(
  {
    agentHarness: configuration.agentHarness.kind,
    agentRunsAs: agentProcessLauncher.description,
    controlPlaneUrl: configuration.controlPlaneUrl,
  },
  "Configuration loaded",
);
await supervisor.start();
