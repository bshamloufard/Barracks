import { createRequire } from "node:module";
import path from "node:path";
import type { DevSettings } from "./dev-settings.js";
import type { ServiceDefinition } from "./service-process.js";

/**
 * How `pnpm dev` starts each service. The control plane runs straight from
 * its TypeScript sources through tsx's loader, and starts each thread's
 * supervisor the same way, so there is nothing to rebuild between runs; the
 * web client runs Vite's dev server.
 */

const tsxLoaderUrl = import.meta.resolve("tsx");

/**
 * The control plane gets the developer's whole environment, so that it can
 * forward model provider keys such as ANTHROPIC_API_KEY to sandboxes; it
 * passes on only an allowlist of them.
 */
export function controlPlaneService(settings: DevSettings): ServiceDefinition {
  return {
    name: "control-plane",
    ...runTypeScriptEntryPoint(settings, "apps/control-plane/src/main.ts"),
    environment: {
      ...process.env,
      // Clients are not authenticated yet, so it must never listen beyond this machine.
      BARRACK_CONTROL_PLANE_HOST: "127.0.0.1",
      BARRACK_CONTROL_PLANE_PORT: String(settings.controlPlanePort),
      ...localProcessSandboxVariables(settings),
      ...agentVariables(settings),
    },
  };
}

export function webClientService(settings: DevSettings): ServiceDefinition {
  const webClientDirectory = path.join(settings.repositoryRoot, "apps/web");
  const requireFromWebClient = createRequire(path.join(webClientDirectory, "package.json"));
  const viteDirectory = path.dirname(requireFromWebClient.resolve("vite/package.json"));
  return {
    name: "web",
    command: process.execPath,
    // A taken port must fail loudly: on any other port the page's origin
    // would not be one the control plane accepts.
    arguments: [
      path.join(viteDirectory, "bin/vite.js"),
      "--port",
      String(settings.webClientPort),
      "--strictPort",
    ],
    workingDirectory: webClientDirectory,
    environment: {
      ...process.env,
      // Where Vite's proxy forwards the page's API, WebSocket and health requests.
      BARRACK_CONTROL_PLANE_PORT: String(settings.controlPlanePort),
    },
  };
}

export function controlPlaneHealthUrl(settings: DevSettings): string {
  return `http://127.0.0.1:${settings.controlPlanePort}/health`;
}

export function webClientUrl(settings: DevSettings): string {
  return `http://localhost:${settings.webClientPort}/`;
}

/**
 * Each thread's sandbox is a directory under `.barrack-dev/sandboxes` and a
 * supervisor process run from its sources, with no isolation at all; see the
 * local-process provider in packages/sandbox-providers.
 */
function localProcessSandboxVariables(settings: DevSettings): NodeJS.ProcessEnv {
  return {
    BARRACK_SANDBOX_PROVIDER: "local-process",
    BARRACK_ALLOW_UNISOLATED_SANDBOXES: "development-only",
    BARRACK_LOCAL_SANDBOX_DIRECTORY: settings.sandboxesDirectory,
    BARRACK_LOCAL_SUPERVISOR_COMMAND: JSON.stringify([
      process.execPath,
      "--import",
      tsxLoaderUrl,
      path.join(settings.repositoryRoot, "apps/sandbox-supervisor/src/main.ts"),
    ]),
    BARRACK_SANDBOX_CONTROL_PLANE_URL: `ws://127.0.0.1:${settings.controlPlanePort}`,
  };
}

function agentVariables(settings: DevSettings): NodeJS.ProcessEnv {
  const { agent } = settings;
  return agent.kind === "fake"
    ? { BARRACK_AGENT_HARNESS: "fake" }
    : { BARRACK_AGENT_HARNESS: "pi", BARRACK_MODEL: agent.model };
}

function runTypeScriptEntryPoint(
  settings: DevSettings,
  entryPoint: string,
): Pick<ServiceDefinition, "command" | "arguments" | "workingDirectory"> {
  return {
    command: process.execPath,
    arguments: ["--import", tsxLoaderUrl, path.join(settings.repositoryRoot, entryPoint)],
    workingDirectory: settings.repositoryRoot,
  };
}
