import { readConfiguration } from "./configuration.js";
import { type RunningControlPlaneServer, startControlPlaneServer } from "./control-plane-server.js";
import { createLogger, type Logger } from "./logger.js";
import { InMemoryThreadEventLog } from "./thread-event-log/in-memory-thread-event-log.js";

async function main(): Promise<void> {
  const configurationResult = readConfiguration(process.env);
  if (!configurationResult.ok) {
    console.error(
      `The control plane cannot start because its configuration is invalid:\n${configurationResult.problems
        .map((problem) => `  - ${problem}`)
        .join("\n")}`,
    );
    process.exitCode = 1;
    return;
  }
  const { configuration } = configurationResult;
  const logger = createLogger(configuration.logLevel);
  if (configuration.webClientDirectory !== undefined) {
    logger.info({ webClientDirectory: configuration.webClientDirectory }, "Serving the web client");
  }
  const server = await startControlPlaneServer({
    configuration,
    threadEventLog: new InMemoryThreadEventLog(),
    logger,
  });
  shutDownOnSignal(server, logger);
}

/**
 * The first SIGINT or SIGTERM closes every connection with "going away" so
 * peers know to reconnect elsewhere; a second one exits at once, for when a
 * peer is slow to finish closing.
 */
function shutDownOnSignal(server: RunningControlPlaneServer, logger: Logger): void {
  let isShuttingDown = false;
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (isShuttingDown) {
      logger.warn({ signal }, "Received a second signal; exiting without waiting");
      process.exit(1);
    }
    isShuttingDown = true;
    logger.info({ signal }, "Shutting down");
    server.close().then(
      () => logger.info("Shut down cleanly"),
      (error: unknown) => {
        logger.error({ err: error }, "Could not shut down cleanly");
        process.exitCode = 1;
      },
    );
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}

main().catch((error: unknown) => {
  console.error("The control plane failed to start:", error);
  process.exitCode = 1;
});
