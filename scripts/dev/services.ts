import { createRequire } from "node:module";
import path from "node:path";
import type { LocalThreadSettings } from "./local-thread-settings.js";
import type { ServiceDefinition } from "./service-process.js";

/**
 * How `pnpm dev` starts each service. The control plane and the supervisor
 * run straight from their TypeScript sources through tsx's loader, so there
 * is nothing to rebuild between runs; the web client runs Vite's dev server.
 */

const tsxLoaderUrl = import.meta.resolve("tsx");

export function controlPlaneService(settings: LocalThreadSettings): ServiceDefinition {
  return {
    name: "control-plane",
    ...runTypeScriptEntryPoint(settings, "apps/control-plane/src/main.ts"),
    environment: {
      ...environmentWithoutSupervisorToken(),
      BARRACK_SUPERVISOR_TOKEN: settings.supervisorToken,
      // Clients are not authenticated yet, so it must never listen beyond this machine.
      BARRACK_CONTROL_PLANE_HOST: "127.0.0.1",
      BARRACK_CONTROL_PLANE_PORT: String(settings.controlPlanePort),
    },
  };
}

export function supervisorService(settings: LocalThreadSettings): ServiceDefinition {
  const { agent } = settings;
  const agentVariables =
    agent.kind === "fake"
      ? { BARRACK_AGENT_HARNESS: "fake" }
      : {
          BARRACK_AGENT_HARNESS: "pi",
          BARRACK_MODEL: agent.model,
          BARRACK_WORKSPACE_DIRECTORY: agent.workspaceDirectory,
          BARRACK_STATE_DIRECTORY: agent.stateDirectory,
        };
  return {
    name: "supervisor",
    ...runTypeScriptEntryPoint(settings, "apps/sandbox-supervisor/src/main.ts"),
    environment: {
      ...environmentWithoutSupervisorToken(),
      BARRACK_CONTROL_PLANE_URL: controlPlaneWebSocketUrl(settings),
      BARRACK_THREAD_ID: settings.threadId,
      BARRACK_SUPERVISOR_TOKEN: settings.supervisorToken,
      ...agentVariables,
    },
  };
}

export function webClientService(settings: LocalThreadSettings): ServiceDefinition {
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
      ...environmentWithoutSupervisorToken(),
      // Where Vite's proxy forwards the page's WebSocket and health requests.
      BARRACK_CONTROL_PLANE_PORT: String(settings.controlPlanePort),
    },
  };
}

export function controlPlaneHealthUrl(settings: LocalThreadSettings): string {
  return `http://127.0.0.1:${settings.controlPlanePort}/health`;
}

export function webClientUrl(settings: LocalThreadSettings): string {
  return `http://localhost:${settings.webClientPort}/?thread=${settings.threadId}`;
}

function controlPlaneWebSocketUrl(settings: LocalThreadSettings): string {
  return `ws://127.0.0.1:${settings.controlPlanePort}`;
}

function runTypeScriptEntryPoint(
  settings: LocalThreadSettings,
  entryPoint: string,
): Pick<ServiceDefinition, "command" | "arguments" | "workingDirectory"> {
  return {
    command: process.execPath,
    arguments: ["--import", tsxLoaderUrl, path.join(settings.repositoryRoot, entryPoint)],
    workingDirectory: settings.repositoryRoot,
  };
}

/** A token left in the developer's shell must not leak into a service that has no use for it. */
function environmentWithoutSupervisorToken(): NodeJS.ProcessEnv {
  const { BARRACK_SUPERVISOR_TOKEN: _ignoredToken, ...environment } = process.env;
  return environment;
}
