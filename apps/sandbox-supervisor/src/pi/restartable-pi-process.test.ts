import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentLaunchRequest,
  AgentProcessLauncher,
  LaunchedAgentProcess,
} from "../agent-process/agent-process-launcher.js";
import { SameUserAgentLauncher } from "../agent-process/same-user-agent-launcher.js";
import { createSilentLogger } from "../test-support/silent-logger.js";
import { getPiDirectories } from "./pi-installation.js";
import { defaultPiStopTiming } from "./pi-stop-timing.js";
import { RestartablePiProcess } from "./restartable-pi-process.js";
import { storedModelCatalogueFileName } from "./stored-model-catalogue.js";

/**
 * The model proxy relays only requests shaped like the pinned Pi's with its
 * built-in model catalogue, so Pi must start with that catalogue and never
 * fetch another: offline whatever the operator's environment says, and with
 * no catalogue stored from before.
 */
describe("how Pi is started", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true })));
  });

  /** Notes what Pi would start with, and starts nothing. */
  class LaunchRecorder implements AgentProcessLauncher {
    readonly description = "a recorder";
    readonly #commands = new SameUserAgentLauncher();
    launches: Array<{ request: AgentLaunchRequest; hasStoredCatalogue: boolean }> = [];

    constructor(readonly storedCataloguePath: string) {}

    launch(request: AgentLaunchRequest): LaunchedAgentProcess {
      this.launches.push({ request, hasStoredCatalogue: existsSync(this.storedCataloguePath) });
      throw new Error("Not started in this test.");
    }

    launchCommand(request: Parameters<AgentProcessLauncher["launchCommand"]>[0]) {
      return this.#commands.launchCommand(request);
    }
  }

  it("runs Pi offline, with no stored model catalogue, even when the operator says otherwise", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "barrack-pi-start-"));
    directories.push(stateDirectory);
    const { agentDirectory } = getPiDirectories(stateDirectory);
    const storedCataloguePath = path.join(agentDirectory, storedModelCatalogueFileName);
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(storedCataloguePath, JSON.stringify({ anthropic: { models: [] } }));
    const launcher = new LaunchRecorder(storedCataloguePath);
    const startFailures: string[] = [];
    const pi = new RestartablePiProcess(
      {
        threadId: "thread-1",
        workspaceDirectory: stateDirectory,
        stateDirectory,
        sourceEnvironment: { PI_OFFLINE: "0" },
        agentProcessLauncher: launcher,
        logger: createSilentLogger(),
        stopTiming: defaultPiStopTiming,
      },
      {
        onEvent: () => {},
        onExit: () => {},
        onStartFailed: (description) => startFailures.push(description),
      },
    );

    await pi.ensureRunning({
      model: "anthropic/a-model",
      credential: { kind: "api_key", secret: "key-for-test", settings: {} },
    });

    expect(startFailures).toEqual([expect.stringContaining("Not started in this test.")]);
    expect(launcher.launches).toHaveLength(1);
    expect(launcher.launches[0]?.hasStoredCatalogue).toBe(false);
    expect(launcher.launches[0]?.request.environment).toMatchObject({ PI_OFFLINE: "1" });
  });
});
