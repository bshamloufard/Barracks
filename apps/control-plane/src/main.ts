import { createSandboxProvider } from "@barrack/sandbox-providers";
import { createConfiguredAuthentication } from "./authentication/create-authenticator.js";
import { type ControlPlaneConfiguration, readConfiguration } from "./configuration.js";
import { type RunningControlPlaneServer, startControlPlaneServer } from "./control-plane-server.js";
import { createLogger, type Logger } from "./logger.js";
import { CredentialResealing, checkCredentialKeys } from "./model-access/credential-key-check.js";
import { CredentialKeyring } from "./model-access/credential-keyring.js";
import { ModelAccessChanges } from "./model-access/model-access-changes.js";
import { ModelCredentials } from "./model-access/model-credentials.js";
import { OwnerModelAccess } from "./model-access/owner-model-access.js";
import {
  defaultGitChildLimits,
  describeUnapplicableLimits,
  findApplicableLimits,
} from "./publication/git-child-limits.js";
import { assembleRepositoryServices } from "./repositories/assemble-repository-services.js";
import {
  assembleThreadServices,
  type ThreadServices,
} from "./sandbox-lifecycle/assemble-thread-services.js";
import { type OpenStorage, openStorage } from "./storage/open-storage.js";

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
  const keyring = new CredentialKeyring(
    configuration.modelCredentialKeys.current,
    configuration.modelCredentialKeys.previous,
  );
  const storage = await openStorage(configuration.database, keyring, logger);
  await checkCredentialKeys(storage.modelCredentialStore, keyring, logger);
  const credentials = new ModelCredentials({ store: storage.modelCredentialStore, logger });
  const isModelRequired = configuration.supervisorEnvironment.agent.harness === "pi";
  const authentication = await createConfiguredAuthentication(
    configuration.authentication,
    storage.userStore,
    logger,
  );
  const repositoryServices = assembleRepositoryServices({
    threadStore: storage.threadStore,
    repositories: storage.threadRepositoryStore,
    connections: storage.githubConnectionStore,
    github: configuration.github,
    logger,
  });
  const threadServices = assembleThreadServices({
    threadStore: storage.threadStore,
    threadEventLog: storage.threadEventLog,
    sandboxProvider: createSandboxProvider(configuration.sandboxProvider),
    sandboxProviderName: configuration.sandboxProvider.kind,
    supervisorEnvironment: configuration.supervisorEnvironment,
    settings: configuration.sandboxLifecycle,
    workspaces: repositoryServices.workspaces,
    modelAccess: new OwnerModelAccess({
      threadStore: storage.threadStore,
      credentials,
      isModelRequired,
    }),
    logger,
  });
  const server = await startControlPlaneServer({
    configuration,
    threadEventLog: storage.threadEventLog,
    threadStore: storage.threadStore,
    relays: threadServices.relays,
    desktops: threadServices.desktops,
    sandboxLifecycle: threadServices.sandboxLifecycle,
    repositoryServices,
    modelAccess: {
      credentials,
      changes: new ModelAccessChanges(storage.threadStore, threadServices.relays),
      isModelRequired,
    },
    publisher: repositoryServices.createPublisher(threadServices.relays),
    authenticator: authentication.authenticator,
    clientAuthentication: authentication.clientAuthentication,
    logger,
  });
  // The first sweep reconciles every sandbox with the provider, and takes
  // over operations a control plane that has gone left under way.
  threadServices.sweeps.start();
  const resealing = new CredentialResealing(storage.modelCredentialStore, keyring, logger);
  resealing.start();
  shutDownOnSignal(server, threadServices, storage, logger, () => resealing.stop());
}

/** Says where agents will run and with what, naming credentials but never their values. */
function describeSandboxes(configuration: ControlPlaneConfiguration, logger: Logger): void {
  const { sandboxProvider, supervisorEnvironment } = configuration;
  logger.info(
    {
      sandboxProvider: sandboxProvider.kind,
      controlPlaneUrlForSandboxes: supervisorEnvironment.controlPlaneUrlForSandboxes,
      agent: supervisorEnvironment.agent,
      forwardedPiSettings: supervisorEnvironment.piSettings,
    },
    "Creating thread sandboxes",
  );
  const { sandboxLifecycle } = configuration;
  logger.info(
    {
      idleMinutes: sandboxLifecycle.idlePeriodInMilliseconds / 60_000,
      runningSandboxesPerUser: sandboxLifecycle.admission.maximumPerUser,
      runningSandboxesInTotal: sandboxLifecycle.admission.maximumInInstallation ?? null,
      checkSeconds: sandboxLifecycle.checkIntervalInMilliseconds / 1000,
    },
    "Stopping idle sandboxes and limiting how many run at once",
  );
  if (sandboxProvider.kind === "local-process") {
    logger.warn(
      "The local-process sandbox provider runs every agent on this machine, as this user, with NO isolation. It is for development only.",
    );
  }
  const { github } = configuration;
  logger.info(
    {
      isGithubAppConfigured: github.app !== undefined,
      githubUrl: github.webUrl,
      allowPlainHttpRepositories: github.allowPlainHttp,
    },
    github.app === undefined
      ? "No GitHub App is configured: threads can clone public repositories only, and nothing can be published"
      : "Threads can work on repositories linked through the GitHub App",
  );
  if (github.allowPlainHttp) {
    logger.warn(
      "Repository URLs may use plain http://, for tests and local development only; never set BARRACK_ALLOW_PLAIN_HTTP_REPOSITORIES in a deployment.",
    );
  }
  if (github.app !== undefined) {
    describePublicationLimits(logger);
  }
}

/** Publishing runs Git on untrusted input; says which of its limits this machine cannot apply. */
function describePublicationLimits(logger: Logger): void {
  const unapplicable = describeUnapplicableLimits(findApplicableLimits());
  if (unapplicable.length === 0) {
    logger.info(
      { gitChildLimits: defaultGitChildLimits },
      "Git commands that publish threads run with limits on memory, processor time, wall time and disk",
    );
    return;
  }
  logger.warn(
    { gitChildLimits: defaultGitChildLimits, unapplicable },
    "This machine cannot limit Git commands that publish threads in every way: a hostile sandbox's bundle can use as much of what is not limited as it likes. Run the control plane on Linux for every limit.",
  );
}

/**
 * The first SIGINT or SIGTERM stops the sweeps, closes every connection with
 * "going away" so peers know to reconnect elsewhere, lets sandbox operations
 * under way finish so that their outcomes are recorded, then closes storage;
 * a second signal exits at once, for when a peer or a provider is slow to
 * finish. An operation cut short that way is taken over by the next control
 * plane once its lease expires.
 */
function shutDownOnSignal(
  server: RunningControlPlaneServer,
  threadServices: ThreadServices,
  storage: OpenStorage,
  logger: Logger,
  stopResealing: () => void,
): void {
  let isShuttingDown = false;
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (isShuttingDown) {
      logger.warn({ signal }, "Received a second signal; exiting without waiting");
      process.exit(1);
    }
    isShuttingDown = true;
    logger.info({ signal }, "Shutting down");
    stopResealing();
    threadServices.sweeps
      .stop()
      .then(() => server.close())
      .then(() => threadServices.operations.whenSettled())
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
