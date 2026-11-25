import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportRevisionForDaytona } from "./revision-export.js";
import type { BuiltSnapshot, SnapshotBuilder } from "./snapshot-build.js";
import { runSnapshotCommand } from "./snapshot-command.js";

/**
 * The snapshot command without Daytona: a throwaway Git repository stands in
 * for this one, and a builder of the test's own for Daytona's, which is
 * never called here.
 */

const run = promisify(execFile);
const apiKey = "dtn_test_key_that_must_never_be_printed";
const sandboxDockerfile = "FROM ubuntu:24.04\nCOPY sandbox-image/barrack-desktop /usr/local/bin/\n";

let repositoryRoot: string;
let printed: string[];

beforeEach(async () => {
  repositoryRoot = await mkdtemp(path.join(tmpdir(), "barrack-snapshot-repository-"));
  printed = [];
  await mkdir(path.join(repositoryRoot, "sandbox-image"));
  await writeFile(path.join(repositoryRoot, "Dockerfile"), "FROM node:22 AS control-plane\n");
  await writeFile(path.join(repositoryRoot, "sandbox-image", "Dockerfile"), sandboxDockerfile);
  await writeFile(path.join(repositoryRoot, "sandbox-image", "barrack-desktop"), "#!/bin/sh\n");
  await writeFile(path.join(repositoryRoot, ".gitignore"), "node_modules/\n");
  const git = (...gitArguments: string[]) =>
    run("git", [
      "-C",
      repositoryRoot,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...gitArguments,
    ]);
  await git("init", "--quiet");
  await git("add", ".");
  await git("commit", "--quiet", "--message", "The sandbox image");
  // Neither of these is part of the commit.
  await writeFile(path.join(repositoryRoot, "uncommitted.txt"), "work in progress\n");
  await mkdir(path.join(repositoryRoot, "node_modules"));
  await writeFile(path.join(repositoryRoot, "node_modules", "ignored.js"), "\n");
});

afterEach(async () => {
  await rm(repositoryRoot, { recursive: true, force: true });
});

const activeSnapshot: BuiltSnapshot = {
  name: "barrack-sandbox-1a2b3c4",
  state: "active",
  size: 1.15,
  entrypoint: ["tini", "--"],
};

function runWith(builder: SnapshotBuilder, commandArguments = ["barrack-sandbox-1a2b3c4"]) {
  return runSnapshotCommand(
    commandArguments,
    { DAYTONA_API_KEY: apiKey },
    { repositoryRoot, createBuilder: () => builder, print: (line) => printed.push(line) },
  );
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

describe("exporting the current commit for Daytona's builder", () => {
  it("writes the committed files only, with the sandbox image's Dockerfile at the root", async () => {
    const exportDirectory = path.join(
      repositoryRoot,
      "..",
      `${path.basename(repositoryRoot)}-export`,
    );

    try {
      const { commit, dockerfilePath } = await exportRevisionForDaytona(
        repositoryRoot,
        exportDirectory,
      );

      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      expect(dockerfilePath).toBe(path.join(exportDirectory, "Dockerfile"));
      expect(await readFile(dockerfilePath, "utf8")).toBe(sandboxDockerfile);
      expect(await exists(path.join(exportDirectory, "sandbox-image", "barrack-desktop"))).toBe(
        true,
      );
      expect(await exists(path.join(exportDirectory, "uncommitted.txt"))).toBe(false);
      expect(await exists(path.join(exportDirectory, "node_modules"))).toBe(false);
    } finally {
      await rm(exportDirectory, { recursive: true, force: true });
      await rm(`${exportDirectory}.tar`, { force: true });
    }
  });
});

describe("the snapshot command", () => {
  it("hands Daytona's builder the exported Dockerfile and says the snapshot is active", async () => {
    let builtFrom: { name: string; dockerfile: string; directory: string } | undefined;
    const builder: SnapshotBuilder = async (snapshotName, dockerfilePath, onLogs) => {
      builtFrom = {
        name: snapshotName,
        dockerfile: await readFile(dockerfilePath, "utf8"),
        directory: path.dirname(dockerfilePath),
      };
      onLogs("Creating snapshot barrack-sandbox-1a2b3c4 (building)");
      return activeSnapshot;
    };

    const exitCode = await runWith(builder);

    expect(exitCode).toBe(0);
    expect(builtFrom).toMatchObject({
      name: "barrack-sandbox-1a2b3c4",
      dockerfile: sandboxDockerfile,
    });
    expect(printed).toEqual([
      expect.stringMatching(
        /^Building snapshot barrack-sandbox-1a2b3c4 from commit [0-9a-f]{40} with Daytona's builder\. Uncommitted changes are not part of it\.$/,
      ),
      "Creating snapshot barrack-sandbox-1a2b3c4 (building)",
      "Snapshot barrack-sandbox-1a2b3c4 is active: 1.15 GB, entrypoint tini --. Set BARRACK_DAYTONA_SNAPSHOT=barrack-sandbox-1a2b3c4 on the control plane.",
    ]);
    expect(await exists(builtFrom?.directory ?? "")).toBe(false);
  });

  it("says a build failed, why, and never the key, even where Daytona quoted it", async () => {
    const builder: SnapshotBuilder = async (_name, _dockerfile, onLogs) => {
      onLogs(`Authorization: Bearer ${apiKey}`);
      throw Object.assign(new Error(`Forbidden for ${apiKey}`), { statusCode: 403 });
    };

    const exitCode = await runWith(builder);

    expect(exitCode).toBe(1);
    expect(printed.join("\n")).not.toContain(apiKey);
    expect(printed.slice(1)).toEqual([
      "Authorization: Bearer [DAYTONA_API_KEY]",
      "Snapshot barrack-sandbox-1a2b3c4 was not built: Forbidden for [DAYTONA_API_KEY] Daytona refused the key: building a snapshot needs a key with write:snapshots.",
    ]);
  });

  it("passes on the reason a snapshot that Daytona could not build failed", async () => {
    const builder: SnapshotBuilder = async () => {
      throw new Error(
        "Failed to create snapshot. Name: barrack-sandbox-1a2b3c4 Reason: build failed",
      );
    };

    expect(await runWith(builder)).toBe(1);
    expect(printed.at(-1)).toBe(
      "Snapshot barrack-sandbox-1a2b3c4 was not built: Failed to create snapshot. Name: barrack-sandbox-1a2b3c4 Reason: build failed",
    );
  });

  it.each([
    [[], "Name the snapshot to build, as the one argument."],
    [["--name", "x"], "Name the snapshot to build, as the one argument."],
    [["barrack sandbox"], 'A snapshot name has no spaces: "barrack sandbox".'],
    [["one", "two"], "Only the snapshot's name is taken; also given: two."],
  ])(
    "refuses the arguments %j, saying why, without building",
    async (commandArguments, problem) => {
      let built = false;
      const exitCode = await runWith(async () => {
        built = true;
        return activeSnapshot;
      }, commandArguments);

      expect(exitCode).toBe(2);
      expect(built).toBe(false);
      expect(printed[0]).toBe(problem);
    },
  );

  it("refuses to start without an API key, naming the permission it needs", async () => {
    const exitCode = await runSnapshotCommand(
      ["barrack-sandbox-1a2b3c4"],
      {},
      {
        repositoryRoot,
        createBuilder: () => async () => activeSnapshot,
        print: (line) => printed.push(line),
      },
    );

    expect(exitCode).toBe(2);
    expect(printed[0]).toBe(
      "DAYTONA_API_KEY: is required, a Daytona API key with write:snapshots (not the control plane's key).",
    );
  });

  it("prints how to use it when asked", async () => {
    expect(await runWith(async () => activeSnapshot, ["--help"])).toBe(0);
    expect(printed[0]).toMatch(/^Usage: DAYTONA_API_KEY=/);
  });
});
