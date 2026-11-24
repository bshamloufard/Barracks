import type { SandboxProvider } from "@barrack/sandbox-providers";
import { ThreadDesktops } from "../desktop/thread-desktops.js";
import type { Logger } from "../logger.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type { ThreadModelAccess } from "../thread-relay/thread-model-access.js";
import { ThreadRelayRegistry } from "../thread-relay/thread-relay-registry.js";
import type { ThreadWorkspaces } from "../thread-relay/thread-workspaces.js";
import type { SupervisorEnvironmentSettings } from "../threads/supervisor-environment.js";
import type { ThreadStore } from "../threads/thread-store.js";
import { IdleSandboxShutdown } from "./idle-sandbox-shutdown.js";
import {
  type Clock,
  deriveLifecycleTiming,
  type LifecycleTiming,
  type SandboxLifecycleSettings,
} from "./lifecycle-settings.js";
import { LifecycleSweeps } from "./lifecycle-sweeps.js";
import { SandboxLifecycle } from "./sandbox-lifecycle.js";
import { SandboxOperations } from "./sandbox-operations.js";
import { SandboxReconciler } from "./sandbox-reconciler.js";

export type ThreadServicesOptions = {
  threadStore: ThreadStore;
  threadEventLog: ThreadEventLog;
  sandboxProvider: SandboxProvider;
  sandboxProviderName: string;
  supervisorEnvironment: SupervisorEnvironmentSettings;
  settings: SandboxLifecycleSettings;
  /** What threads' workspaces hold; empty when omitted. */
  workspaces?: ThreadWorkspaces;
  /** Threads' models and their owners' keys; none when omitted. */
  modelAccess?: ThreadModelAccess;
  logger: Logger;
  /** The real time unless a test controls it. */
  clock?: Clock;
  /** Replaces some of the timings derived from the settings, for tests. */
  timing?: Partial<LifecycleTiming>;
};

/** What runs threads: their relays, their sandboxes' lifecycle, and the sweeps that keep both true. */
export type ThreadServices = {
  relays: ThreadRelayRegistry;
  desktops: ThreadDesktops;
  sandboxLifecycle: SandboxLifecycle;
  operations: SandboxOperations;
  reconciler: SandboxReconciler;
  idleShutdown: IdleSandboxShutdown;
  sweeps: LifecycleSweeps;
};

/**
 * Builds the thread relays, the desktops and the sandbox lifecycle, which
 * need each other: a relay asks the lifecycle before it records a message
 * (which may wake a sandbox), and the lifecycle asks the relays to
 * interrupt and close runs when it stops one; the desktops reach
 * supervisors and clients through the relays, which ask the desktops who
 * holds each one. Each is given the other through a function called only
 * once both exist.
 */
export function assembleThreadServices(options: ThreadServicesOptions): ThreadServices {
  const { threadStore, threadEventLog, sandboxProvider, settings, logger } = options;
  const clock = options.clock ?? (() => new Date());
  const timing = { ...deriveLifecycleTiming(settings), ...options.timing };
  const lifecycleOf = (): SandboxLifecycle => sandboxLifecycle;
  const desktops = new ThreadDesktops({ channel: () => relays, logger });
  const relays = new ThreadRelayRegistry({
    threadEventLog,
    threadActivity: {
      admitUserMessage: (threadId, text) => lifecycleOf().admitUserMessage(threadId, text),
      recordAgentActivity: (threadId) => lifecycleOf().recordAgentActivity(threadId),
    },
    ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
    ...(options.modelAccess === undefined ? {} : { modelAccess: options.modelAccess }),
    desktops,
    logger,
  });
  const operations = new SandboxOperations({
    threadStore,
    threadEventLog,
    sandboxProvider,
    supervisorEnvironment: options.supervisorEnvironment,
    threadRuns: relays,
    clock,
    timing,
    logger,
  });
  const sandboxLifecycle = new SandboxLifecycle({
    threadStore,
    operations,
    sandboxProviderName: options.sandboxProviderName,
    settings,
    timing,
    clock,
    logger,
  });
  const reconciler = new SandboxReconciler({
    threadStore,
    sandboxProvider,
    operations,
    threadEventLog,
    threadRuns: relays,
    clock,
    logger,
  });
  const idleShutdown = new IdleSandboxShutdown({
    threadStore,
    threadEventLog,
    operations,
    idlePeriodInMilliseconds: settings.idlePeriodInMilliseconds,
    clock,
    logger,
  });
  const sweeps = new LifecycleSweeps({
    reconciler,
    idleShutdown,
    intervalInMilliseconds: settings.checkIntervalInMilliseconds,
    logger,
  });
  return { relays, desktops, sandboxLifecycle, operations, reconciler, idleShutdown, sweeps };
}
