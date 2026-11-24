import path from "node:path";
import { type DevSettings, prepareSandboxesDirectory, readDevSettings } from "./dev-settings.js";
import { labelOutputLine, ServiceProcess } from "./service-process.js";
import {
  controlPlaneHealthUrl,
  controlPlaneService,
  webClientService,
  webClientUrl,
} from "./services.js";
import { waitUntilReachable } from "./wait-until-reachable.js";

/**
 * `pnpm dev`: the whole system on this machine. It starts the control
 * plane, which creates a sandbox (here a plain directory and supervisor
 * process) for each thread created from the web page, then the web
 * client's dev server, and prints the address to open. Ctrl-C stops both;
 * if either stops on its own, the other is stopped too and this exits with
 * an error.
 */

/** The control plane stops the supervisors it started, which give Pi a moment to finish. */
const controlPlaneGracePeriodInMilliseconds = 15_000;
const webClientGracePeriodInMilliseconds = 5_000;
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

let controlPlane: ServiceProcess | undefined;
let webClient: ServiceProcess | undefined;
let isStopping = false;

async function main(): Promise<void> {
  if (process.platform === "win32") {
    throw new Error("pnpm dev needs process groups, which Windows lacks; run it under WSL.");
  }
  const settings = readDevSettings(process.env, repositoryRoot);
  await prepareSandboxesDirectory(settings);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void stopEverything(0, `received ${signal}`));
  }
  report(describeAgent(settings));
  report(
    `Each thread's sandbox is a directory in ${settings.sandboxesDirectory} with NO isolation: the agent can do anything your user can.`,
  );

  controlPlane = startService(new ServiceProcess(controlPlaneService(settings)));
  await waitUntilReachable(controlPlaneHealthUrl(settings));
  webClient = startService(new ServiceProcess(webClientService(settings)));
  await waitUntilReachable(webClientUrl(settings));

  report(`Open ${webClientUrl(settings)} and create a thread.`);
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

/** Stops both services together. A second Ctrl-C does not wait. */
async function stopEverything(exitCode: number, reason: string): Promise<void> {
  if (isStopping) {
    report("Stopping without waiting.");
    process.exit(1);
  }
  isStopping = true;
  report(`Stopping, because ${reason}.`);
  const exits = await Promise.all([
    controlPlane?.stop(controlPlaneGracePeriodInMilliseconds),
    webClient?.stop(webClientGracePeriodInMilliseconds),
  ]);
  const hasEveryServiceStoppedCleanly = exits.every((exit) => exit?.wasSuccessful ?? true);
  if (exitCode === 0 && !hasEveryServiceStoppedCleanly) {
    report("Not every service stopped cleanly; see its output above.");
  }
  process.exit(hasEveryServiceStoppedCleanly ? exitCode : 1);
}

function describeAgent(settings: DevSettings): string {
  const { agent } = settings;
  if (agent.kind === "fake") {
    return "Using the fake agent. Set BARRACK_MODEL (and your model provider's key) to use Pi.";
  }
  return `Using Pi with ${agent.model}.`;
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
