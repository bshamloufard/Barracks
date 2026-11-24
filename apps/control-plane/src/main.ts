import { createSandboxProvider } from "@barrack/sandbox-providers";
import { type ControlPlaneConfiguration, readConfiguration } from "./configuration.js";
import { type RunningControlPlaneServer, startControlPlaneServer } from "./control-plane-server.js";
import { createLogger, type Logger } from "./logger.js";
import { type OpenStorage, openStorage } from "./storage/open-storage.js";
import { ThreadCreator } from "./threads/thread-creator.js";

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
  describeSandboxes(configuration, logger);
  // The database is migrated before the server listens, so nothing is
  // accepted that could not be recorded.
  const storage = await openStorage(configuration.database, logger);
  const threadCreator = new ThreadCreator({
    threadStore: storage.threadStore,
    sandboxProvider: createSandboxProvider(configuration.sandboxProvider),
    sandboxProviderName: configuration.sandboxProvider.kind,
    supervisorEnvironment: configuration.supervisorEnvironment,
    logger,
  });
  const server = await startControlPlaneServer({
    configuration,
    threadEventLog: storage.threadEventLog,
    threadStore: storage.threadStore,
    threadCreator,
    logger,
  });
  shutDownOnSignal(server, threadCreator, storage, logger);
}

/** Says where agents will run and with what, naming credentials but never their values. */
function describeSandboxes(configuration: ControlPlaneConfiguration, logger: Logger): void {
  const { sandboxProvider, supervisorEnvironment } = configuration;
  logger.info(
    {
      sandboxProvider: sandboxProvider.kind,
      controlPlaneUrlForSandboxes: supervisorEnvironment.controlPlaneUrlForSandboxes,
      agent: supervisorEnvironment.agent,
      forwardedModelCredentials: Object.keys(supervisorEnvironment.modelCredentials),
    },
    "Creating thread sandboxes",
  );
  if (sandboxProvider.kind === "local-process") {
    logger.warn(
      "The local-process sandbox provider runs every agent on this machine, as this user, with NO isolation. It is for development only.",
    );
  }
  if (supervisorEnvironment.agent.harness === "pi") {
    logger.warn(
      "Model provider keys in this environment are forwarded to every thread's sandbox, where the agent can read them. This stands in for per-user model access until it is built.",
    );
  }
}

/**
 * The first SIGINT or SIGTERM closes every connection with "going away" so
 * peers know to reconnect elsewhere, lets sandbox creations under way finish
 * so none is left unrecorded, then closes storage; a second signal exits at
 * once, for when a peer or a provider is slow to finish.
 */
function shutDownOnSignal(
  server: RunningControlPlaneServer,
  threadCreator: ThreadCreator,
  storage: OpenStorage,
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
      .then(() => threadCreator.whenSandboxCreationsSettle())
      .then(() => storage.close())
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
