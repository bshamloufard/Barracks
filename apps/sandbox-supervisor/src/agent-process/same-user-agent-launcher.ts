import { spawn } from "node:child_process";
import type {
  AgentCommandRequest,
  AgentLaunchRequest,
  AgentProcessLauncher,
  AgentProcessStdio,
  LaunchedAgentProcess,
} from "./agent-process-launcher.js";
import { listDescendantProcessIds } from "./list-descendant-process-ids.js";
import { sendSignalUnlessGone } from "./send-signal-unless-gone.js";

/**
 * Runs the agent as the supervisor's own user, which is how the supervisor
 * runs on a developer's machine. Nothing separates the two: the agent can
 * read the supervisor's environment, token included, through `/proc` (see
 * the supervisor's README).
 */
export class SameUserAgentLauncher implements AgentProcessLauncher {
  readonly description = "the supervisor's own user";

  launch(request: AgentLaunchRequest): LaunchedAgentProcess {
    const child = spawn(process.execPath, [request.scriptPath, ...request.scriptArguments], {
      cwd: request.workingDirectory,
      env: request.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      child,
      signalAgentProcesses: (signal) => signalProcessTree(child.pid, signal),
    };
  }

  launchCommand(request: AgentCommandRequest): AgentProcessStdio {
    return spawn(request.executable, [...request.arguments], {
      cwd: request.workingDirectory,
      env: request.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}

/**
 * Signals the agent's process and its descendants as they are at this
 * moment. A process that has left the tree (by starting a daemon, say) is
 * out of reach here; only the separate-user launcher can find those.
 */
async function signalProcessTree(
  rootProcessId: number | undefined,
  signal: NodeJS.Signals,
): Promise<void> {
  if (rootProcessId === undefined) {
    return;
  }
  // Listed before signalling, because a signalled process may take its
  // children with it and leave their own children to be reparented.
  let descendantProcessIds: number[] = [];
  let listingFailure: unknown;
  try {
    descendantProcessIds = await listDescendantProcessIds(rootProcessId);
  } catch (error) {
    listingFailure = error;
  }
  for (const processId of [rootProcessId, ...descendantProcessIds]) {
    sendSignalUnlessGone(processId, signal);
  }
  if (listingFailure !== undefined) {
    throw new Error("Signalled only the agent's own process: its descendants could not be listed", {
      cause: listingFailure,
    });
  }
}
