import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxRefusedError } from "../sandbox-provider-errors.js";
import {
  standInLaunchFileName,
  standInSupervisorCommand,
} from "../test-support/stand-in-supervisor.js";
import { LocalProcessSandboxProvider } from "./local-process-sandbox-provider.js";

type StandInLaunch = { environment: Record<string, string>; workingDirectory: string };

const { PATH: searchPath } = process.env;
const hostEnvironment = {
  PATH: searchPath,
  HOME: "/home/developer",
  DATABASE_PASSWORD: "the control plane's secret, not the sandbox's",
};

let sandboxesDirectory: string;
let provider: LocalProcessSandboxProvider;
const createdSandboxIds: string[] = [];

beforeEach(async () => {
  sandboxesDirectory = await mkdtemp(path.join(tmpdir(), "barrack-local-sandboxes-"));
  provider = createProvider(standInSupervisorCommand);
});

afterEach(async () => {
  await Promise.all(createdSandboxIds.splice(0).map((id) => provider.destroy(id)));
  await rm(sandboxesDirectory, { recursive: true, force: true });
});

function createProvider(supervisorCommand: [string, ...string[]]): LocalProcessSandboxProvider {
  return new LocalProcessSandboxProvider(
    { supervisorCommand, sandboxesDirectory, stopTimeoutInMilliseconds: 5_000 },
    hostEnvironment,
  );
}

async function createSandbox(supervisorEnvironment: Record<string, string> = {}): Promise<string> {
  const { sandboxId } = await provider.create({ threadId: "thread-1", supervisorEnvironment });
  createdSandboxIds.push(sandboxId);
  return sandboxId;
}

function workspaceOf(sandboxId: string): string {
  const workspaceDirectory = provider.workspaceDirectoryOf(sandboxId);
  if (workspaceDirectory === undefined) {
    throw new Error(`Sandbox ${sandboxId} does not exist.`);
  }
  return workspaceDirectory;
}

async function readLaunch(sandboxId: string): Promise<StandInLaunch> {
  const launchFile = path.join(workspaceOf(sandboxId), standInLaunchFileName);
  await vi.waitFor(() => expect(existsSync(launchFile)).toBe(true), { timeout: 5_000 });
  return JSON.parse(await readFile(launchFile, "utf8"));
}

describe("the local-process sandbox provider", () => {
  it("runs the supervisor in the sandbox's own workspace, with the requested environment, the sandbox's directories and only the host's basics", async () => {
    const sandboxId = await createSandbox({
      BARRACK_THREAD_ID: "thread-1",
      BARRACK_SUPERVISOR_TOKEN: "secret",
    });

    const launch = await readLaunch(sandboxId);

    const workspaceDirectory = workspaceOf(sandboxId);
    expect(await realpath(launch.workingDirectory)).toBe(await realpath(workspaceDirectory));
    expect(launch.environment).toMatchObject({
      HOME: "/home/developer",
      BARRACK_THREAD_ID: "thread-1",
      BARRACK_SUPERVISOR_TOKEN: "secret",
      BARRACK_WORKSPACE_DIRECTORY: workspaceDirectory,
      BARRACK_STATE_DIRECTORY: path.join(path.dirname(workspaceDirectory), "state"),
      BARRACK_SUPERVISOR_STATE_DIRECTORY: path.join(path.dirname(workspaceDirectory), "supervisor"),
    });
    expect(launch.environment).not.toHaveProperty("DATABASE_PASSWORD");
  });

  it("tells the supervisor, by name, that its agent shares its user, since there is no other", async () => {
    const sandboxId = await createSandbox({ BARRACK_THREAD_ID: "thread-1" });

    const launch = await readLaunch(sandboxId);

    expect(launch.environment).toMatchObject({
      BARRACK_AGENT_SHARES_SUPERVISOR_USER: "development-only",
    });
  });

  it("makes each workspace a Git repository of its own, so the agent's Git commands stop there", async () => {
    const sandboxId = await createSandbox();

    const { stdout } = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspaceOf(sandboxId),
    });

    expect(await realpath(stdout.trim())).toBe(await realpath(workspaceOf(sandboxId)));
  });

  it("gives every sandbox a directory of its own", async () => {
    const first = await createSandbox();
    const { sandboxId: second } = await provider.create({
      threadId: "thread-2",
      supervisorEnvironment: {},
    });
    createdSandboxIds.push(second);

    expect(workspaceOf(first)).not.toBe(workspaceOf(second));
  });

  it("reports a sandbox whose supervisor exited by itself as failed, saying how it exited", async () => {
    const sandboxId = await createSandbox({ STAND_IN_EXIT_CODE: "3" });

    await vi.waitFor(async () =>
      expect(await provider.getStatus(sandboxId)).toEqual({
        state: "failed",
        reason: "its supervisor exited by itself (exit code 3)",
      }),
    );
  });

  it("refuses a sandbox whose supervisor cannot be started, and leaves nothing behind", async () => {
    provider = createProvider(["/no/such/supervisor"]);

    const creation = provider.create({ threadId: "thread-1", supervisorEnvironment: {} });

    await expect(creation).rejects.toThrow(SandboxRefusedError);
    expect(await readdir(sandboxesDirectory)).toEqual([]);
  });

  it("has a supervisor's process recorded before the supervisor runs, so no supervisor runs unseen", async () => {
    // The first thing this supervisor does is look for its own record.
    provider = createProvider([
      "/bin/sh",
      "-c",
      'cat ../supervisor.pid > recorded-before-running; printf "%s" "$$" > own-process; exec sleep 30',
    ]);
    const sandboxId = await createSandbox();
    const workspace = workspaceOf(sandboxId);
    const readInWorkspace = (fileName: string) => readFile(path.join(workspace, fileName), "utf8");
    await vi.waitFor(() => expect(existsSync(path.join(workspace, "own-process"))).toBe(true));

    expect(await readInWorkspace("recorded-before-running")).toBe(
      await readInWorkspace("own-process"),
    );
    expect(await provider.getStatus(sandboxId)).toEqual({ state: "running" });
  });

  it("reports a stop cut short as stopping, and lets a provider opened afresh finish it", async () => {
    const sandboxId = await createSandbox();
    const sandboxDirectory = path.dirname(workspaceOf(sandboxId));
    const processId = Number(await readFile(path.join(sandboxDirectory, "supervisor.pid"), "utf8"));
    // What a control plane killed between marking the stop and signalling leaves behind.
    await rename(
      path.join(sandboxDirectory, "supervisor.pid"),
      path.join(sandboxDirectory, "supervisor-stopping.pid"),
    );
    const reopened = createProvider(standInSupervisorCommand);

    const statusWhileCutShort = await reopened.getStatus(sandboxId);
    await reopened.stop(sandboxId);

    expect(statusWhileCutShort).toEqual({ state: "stopping" });
    expect(await reopened.getStatus(sandboxId)).toEqual({ state: "stopped" });
    expect(() => process.kill(processId, 0)).toThrow();
  });

  it("removes the sandbox's directory when it is destroyed", async () => {
    const sandboxId = await createSandbox();
    const sandboxDirectory = path.dirname(workspaceOf(sandboxId));

    await provider.destroy(sandboxId);

    expect(existsSync(sandboxDirectory)).toBe(false);
  });
});
