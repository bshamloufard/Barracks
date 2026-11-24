import path from "node:path";
import {
  type LocalThreadSettings,
  prepareAgentDirectories,
  readLocalThreadSettings,
} from "./local-thread-settings.js";
import { labelOutputLine, ServiceProcess } from "./service-process.js";
import {
  controlPlaneHealthUrl,
  controlPlaneService,
  supervisorService,
  webClientService,
  webClientUrl,
} from "./services.js";
import { waitUntilReachable } from "./wait-until-reachable.js";

/**
 * `pnpm dev`: the whole system on this machine for one thread. It starts the
 * control plane, then a sandbox supervisor and the web client's dev server,
 * and prints the address to open. Ctrl-C stops all three; if any of them
 * stops on its own, the others are stopped too and this exits with an error.
 */

/** The supervisor gives Pi several seconds to finish, so it gets longer than the rest. */
const supervisorGracePeriodInMilliseconds = 15_000;
const gracePeriodInMilliseconds = 5_000;
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

let controlPlane: ServiceProcess | undefined;
let supervisor: ServiceProcess | undefined;
let webClient: ServiceProcess | undefined;
let isStopping = false;

async function main(): Promise<void> {
  if (process.platform === "win32") {
    throw new Error("pnpm dev needs process groups, which Windows lacks; run it under WSL.");
  }
  const settings = readLocalThreadSettings(process.env, repositoryRoot);
  await prepareAgentDirectories(settings.agent);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void stopEverything(0, `received ${signal}`));
  }
  report(describeAgent(settings));

  controlPlane = startService(new ServiceProcess(controlPlaneService(settings)));
  await waitUntilReachable(controlPlaneHealthUrl(settings));
  supervisor = startService(new ServiceProcess(supervisorService(settings)));
  webClient = startService(new ServiceProcess(webClientService(settings)));
  await waitUntilReachable(webClientUrl(settings));

  report(`Open ${webClientUrl(settings)}`);
  report("Press Ctrl-C to stop.");
}

/** Every service is expected to run until `pnpm dev` stops it. */
function startService(service: ServiceProcess): ServiceProcess {
  void service.exited.then((exit) => {
    if (!isStopping) {
      void stopEverything(1, `${service.name} ${exit.description}`);
    }
  });
  return service;
}

/**
 * Stops the supervisor first, so the agent's last events still reach the
 * control plane, then the control plane and the web client together. A
 * second Ctrl-C does not wait.
 */
async function stopEverything(exitCode: number, reason: string): Promise<void> {
  if (isStopping) {
    report("Stopping without waiting.");
    process.exit(1);
  }
  isStopping = true;
  report(`Stopping, because ${reason}.`);
  const supervisorExit = await supervisor?.stop(supervisorGracePeriodInMilliseconds);
  const otherExits = await Promise.all(
    [controlPlane, webClient].map((service) => service?.stop(gracePeriodInMilliseconds)),
  );
  const exits = [supervisorExit, ...otherExits];
  const hasEveryServiceStoppedCleanly = exits.every((exit) => exit?.wasSuccessful ?? true);
  if (exitCode === 0 && !hasEveryServiceStoppedCleanly) {
    report("Not every service stopped cleanly; see its output above.");
  }
  process.exit(hasEveryServiceStoppedCleanly ? exitCode : 1);
}

function describeAgent(settings: LocalThreadSettings): string {
  const { agent } = settings;
  if (agent.kind === "fake") {
    return "Using the fake agent. Set BARRACK_MODEL (and your model provider's key) to use Pi.";
  }
  return `Using Pi with ${agent.model}, working in ${agent.workspaceDirectory}.`;
}

function report(message: string): void {
  process.stdout.write(labelOutputLine("dev", message));
}

main().catch((error: unknown) => {
  if (isStopping) {
    return;
  }
  const reason = error instanceof Error ? error.message : String(error);
  void stopEverything(1, `starting failed: ${reason}`);
});
