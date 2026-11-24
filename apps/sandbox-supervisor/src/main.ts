import { readConfiguration } from "./configuration.js";
import { createLogger } from "./logger.js";
import { Supervisor } from "./supervisor.js";

const configurationResult = readConfiguration(process.env);
if (!configurationResult.ok) {
  const problemList = configurationResult.problems.map((problem) => `  - ${problem}`).join("\n");
  process.stderr.write(
    `The sandbox supervisor cannot start: its configuration is invalid.\n${problemList}\n`,
  );
  process.exit(1);
}

const { configuration } = configurationResult;
const logger = createLogger(configuration.logLevel, configuration.threadId);
let isShuttingDown = false;

const supervisor = new Supervisor({
  configuration,
  // Pi's environment is built from an allowlist of this one that leaves the
  // supervisor token out. The agent can still read the token from this
  // process; src/pi/pi-environment.ts says exactly what is protected.
  sourceEnvironment: process.env,
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
  { agentHarness: configuration.agentHarness.kind, controlPlaneUrl: configuration.controlPlaneUrl },
  "Configuration loaded",
);
await supervisor.start();
