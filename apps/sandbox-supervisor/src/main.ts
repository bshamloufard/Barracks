import type { AgentProcessLauncher } from "./agent-process/agent-process-launcher.js";
import { prepareAgentProcessLauncher } from "./agent-process/prepare-agent-process-launcher.js";
import { SameUserAgentLauncher } from "./agent-process/same-user-agent-launcher.js";
import { type AgentHarnessConfiguration, readConfiguration } from "./configuration.js";
import { createLogger } from "./logger.js";
import { getPiDirectories } from "./pi/pi-agent-harness.js";
import { Supervisor } from "./supervisor.js";

function exitWithProblems(problems: readonly string[]): never {
  const problemList = problems.map((problem) => `  - ${problem}`).join("\n");
  process.stderr.write(
    `The sandbox supervisor cannot start: its configuration is invalid.\n${problemList}\n`,
  );
  process.exit(1);
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

const { configuration } = configurationResult;
const agentProcessLauncher = await prepareLauncher(configuration.agentHarness);
const logger = createLogger(configuration.logLevel, configuration.threadId);
let isShuttingDown = false;

const supervisor = new Supervisor({
  configuration,
  // Pi's environment is built from an allowlist of this one that leaves the
  // supervisor token out. Whether the agent could still read the token from
  // this process depends on the user it runs as; src/pi/pi-environment.ts
  // says exactly what is protected.
  sourceEnvironment: process.env,
  agentProcessLauncher,
  logger,
  onFatalError: (error) => void shutDown(1, error.message),
});

async function shutDown(exitCode: number, reason: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  logger.info({ reason, exitCode }, "Shutting down");
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
