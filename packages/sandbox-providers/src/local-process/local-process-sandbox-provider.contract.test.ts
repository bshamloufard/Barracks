import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSupervisorEndpointPath } from "@barrack/protocol";
import { describeSandboxProviderContract } from "../test-support/sandbox-provider-contract.js";
import {
  standInLaunchFileName,
  standInSupervisorCommand,
} from "../test-support/stand-in-supervisor.js";
import { SupervisorConnectionRecorder } from "../test-support/supervisor-connection-recorder.js";
import { LocalProcessSandboxProvider } from "./local-process-sandbox-provider.js";

/**
 * The contract against real child processes: a stand-in supervisor that
 * connects out to a recorder, as the real one connects to the control plane.
 *
 * The contract's paths are those of the sandbox image (`/workspace/…`); in a
 * local sandbox the workspace is a directory of its own on this machine.
 */

const supervisorConnectionTimeoutInMilliseconds = 10_000;
const imageWorkspacePrefix = "/workspace/";

describeSandboxProviderContract({
  providerName: "local-process",
  unavailableReason: undefined,
  async setUp() {
    const sandboxesDirectory = await mkdtemp(path.join(tmpdir(), "barrack-local-sandboxes-"));
    const recorder = await SupervisorConnectionRecorder.listen("127.0.0.1");
    const settings = {
      supervisorCommand: standInSupervisorCommand,
      sandboxesDirectory,
      stopTimeoutInMilliseconds: 5_000,
    };
    const provider = new LocalProcessSandboxProvider(settings);
    const workspaceOf = (sandboxId: string): string => {
      const workspaceDirectory = provider.workspaceDirectoryOf(sandboxId);
      if (workspaceDirectory === undefined) {
        throw new Error(`Sandbox ${sandboxId} does not exist.`);
      }
      return workspaceDirectory;
    };
    const localPathOf = (sandboxId: string, imagePath: string): string => {
      if (!imagePath.startsWith(imageWorkspacePrefix)) {
        throw new Error(`Cannot map ${imagePath} into sandbox ${sandboxId}.`);
      }
      return path.join(workspaceOf(sandboxId), imagePath.slice(imageWorkspacePrefix.length));
    };
    const sandboxDirectoryOf = (sandboxId: string): string => path.dirname(workspaceOf(sandboxId));
    return {
      provider,
      unknownSandboxId: "local-sandbox-that-was-never-created",
      supervisorEnvironmentFor: (threadId) => ({
        BARRACK_THREAD_ID: threadId,
        STAND_IN_CONNECT_URL: `ws://127.0.0.1:${recorder.port}${buildSupervisorEndpointPath({ threadId })}`,
      }),
      reopenProvider: () => new LocalProcessSandboxProvider(settings),
      waitForSupervisorLaunches: (threadId, launchCount) =>
        recorder.waitForConnections(
          threadId,
          launchCount,
          supervisorConnectionTimeoutInMilliseconds,
        ),
      async writeFile(sandboxId, imagePath, content) {
        await writeFile(localPathOf(sandboxId, imagePath), content);
      },
      readFile: (sandboxId, imagePath) => readFile(localPathOf(sandboxId, imagePath), "utf8"),
      readSecretAsSupervisor: (sandboxId, secretName) =>
        readFile(path.join(sandboxDirectoryOf(sandboxId), "secrets", secretName), "utf8"),
      // What it keeps about a sandbox, and the environment its supervisor runs with.
      async describeSandboxAsProviderReportsIt(sandboxId) {
        const record = await readFile(
          path.join(sandboxDirectoryOf(sandboxId), "sandbox-record.json"),
          "utf8",
        );
        const launch = await readFile(
          path.join(workspaceOf(sandboxId), standInLaunchFileName),
          "utf8",
        );
        return `${record}\n${launch}`;
      },
      agentCommands: {
        unavailableBecause:
          "a local-process sandbox has no command interface, and its agent runs as the supervisor's user",
      },
      async dispose() {
        await recorder.close();
        await rm(sandboxesDirectory, { recursive: true, force: true });
      },
    };
  },
});
