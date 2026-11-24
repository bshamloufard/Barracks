import { relayedProviders } from "@barrack/model-catalogue";
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
import { assembleModelProxy } from "./model-proxy/assemble-model-proxy.js";
import type { ModelProxy } from "./model-proxy/model-proxy.js";
import { defaultModelProxyLimits } from "./model-proxy/model-proxy-limits.js";
import { ModelProxyTokens } from "./model-proxy/model-proxy-tokens.js";
import { ModelSwitchAllowances } from "./model-proxy/model-switch-allowances.js";
import { ModelUsage } from "./model-usage/model-usage.js";
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
  const proxyTokens = new ModelProxyTokens(storage.modelProxyTokenStore);
  const modelSwitchAllowances = new ModelSwitchAllowances({
    store: storage.modelSwitchAllowanceStore,
    threadEventLog: storage.threadEventLog,
    tokens: proxyTokens,
  });
  const modelUsage = new ModelUsage({
    store: storage.modelUsageStore,
    settings: configuration.modelUsageCap,
    logger,
  });
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
      proxyTokens,
      usage: modelUsage,
      controlPlaneUrlForSandboxes: toHttpUrl(
        configuration.supervisorEnvironment.controlPlaneUrlForSandboxes,
      ),
    }),
    logger,
  });
  const modelProxy = assembleModelProxy({
    threadStore: storage.threadStore,
    modelSwitchAllowances,
    userStore: storage.userStore,
    admission: authentication.admission,
    credentials,
    tokens: proxyTokens,
    usage: modelUsage,
    endings: threadServices.relays,
    upstreamOrigin: configuration.modelProxyUpstreamOrigin,
    limits: { maximumRequestBytesHeldInTotal: configuration.modelProxyRequestBodiesHeldInBytes },
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
      changes: new ModelAccessChanges(
        storage.threadStore,
        threadServices.relays,
        modelSwitchAllowances,
      ),
      isModelRequired,
    },
    modelProxy,
    modelUsage,
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
  shutDownOnSignal({
    server,
    modelProxy,
    threadServices,
    storage,
    logger,
    stopResealing: () => resealing.stop(),
  });
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
  describeModelAccess(configuration, logger);
}

/** Says which providers' keys stay here, the cap on usage and the proxy's memory bounds; never a key. */
function describeModelAccess(configuration: ControlPlaneConfiguration, logger: Logger): void {
  const { modelUsageCap, modelProxyUpstreamOrigin, modelProxyRequestBodiesHeldInBytes } =
    configuration;
  logger.info(
    {
      providersWhoseKeysStayHere: relayedProviders.map((provider) => provider.providerId),
      usageCapTokens: modelUsageCap.installationCapTokens ?? null,
      usageCapWindowHours: modelUsageCap.windowHours,
      largestRequestBodyInBytes: defaultModelProxyLimits.maximumRequestBytes,
      requestBodiesHeldAtOnceInBytes: modelProxyRequestBodiesHeldInBytes,
    },
    "Relaying some providers' model traffic so their keys stay out of sandboxes; every other provider's key is placed in the sandbox",
  );
  if (modelProxyUpstreamOrigin !== undefined) {
    logger.warn(
      { modelProxyUpstreamOrigin },
      "The model proxy sends every provider's requests to this origin instead of the provider's, for tests and local development only; never set BARRACK_MODEL_PROXY_UPSTREAM_ORIGIN in a deployment.",
    );
  }
}

/** Sandboxes reach the control plane's WebSockets at this URL, and its HTTP at the same place. */
function toHttpUrl(webSocketUrl: string): string {
  return webSocketUrl.replace(/^ws(s?):/, "http$1:");
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
 * How long the model proxy waits, at shutdown, for the requests it ended to
 * record their usage: well inside the 120-second drain the deployment
 * gives (see the deployment guide), with room for the database's retries.
 */
const modelProxyShutdownGraceInMilliseconds = 30_000;

/**
 * The first SIGINT or SIGTERM stops the sweeps, ends the model proxy's
 * requests in flight and records their usage, closes every connection with
 * "going away" so peers know to reconnect elsewhere, lets sandbox operations
 * under way finish so that their outcomes are recorded, then closes storage;
 * a second signal exits at once, for when a peer or a provider is slow to
 * finish. An operation cut short that way is taken over by the next control
 * plane once its lease expires.
 */
function shutDownOnSignal(running: {
  server: RunningControlPlaneServer;
  modelProxy: ModelProxy;
  threadServices: ThreadServices;
  storage: OpenStorage;
  logger: Logger;
  stopResealing: () => void;
}): void {
  const { server, modelProxy, threadServices, storage, logger, stopResealing } = running;
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
      .then(() => modelProxy.shutDown(modelProxyShutdownGraceInMilliseconds))
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
