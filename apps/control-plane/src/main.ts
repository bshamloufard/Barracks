import { readConfiguration } from "./configuration.js";
import { type RunningControlPlaneServer, startControlPlaneServer } from "./control-plane-server.js";
import { createLogger, type Logger } from "./logger.js";
import {
  type OpenThreadEventLog,
  openThreadEventLog,
} from "./thread-event-log/open-thread-event-log.js";

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
  // The database is migrated before the server listens, so nothing is
  // accepted that could not be recorded.
  const openLog = await openThreadEventLog(configuration.database, logger);
  const server = await startControlPlaneServer({
    configuration,
    threadEventLog: openLog.threadEventLog,
    logger,
  });
  shutDownOnSignal(server, openLog, logger);
}

/**
 * The first SIGINT or SIGTERM closes every connection with "going away" so
 * peers know to reconnect elsewhere, then closes the event log; a second one
 * exits at once, for when a peer is slow to finish closing.
 */
function shutDownOnSignal(
  server: RunningControlPlaneServer,
  openLog: OpenThreadEventLog,
  logger: Logger,
): void {
  let isShuttingDown = false;
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (isShuttingDown) {
      logger.warn({ signal }, "Received a second signal; exiting without waiting");
      process.exit(1);
    }
    isShuttingDown = true;
    logger.info({ signal }, "Shutting down");
    server
      .close()
      .then(() => openLog.close())
      .then(
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
