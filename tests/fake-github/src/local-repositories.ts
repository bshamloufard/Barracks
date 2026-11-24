import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Bare Git repositories on disk, which the fake GitHub serves over HTTP.
 * Git here runs with no user or system configuration, so the developer's
 * own settings never leak into a test.
 */

const { PATH: searchPath } = process.env;

const gitEnvironment: NodeJS.ProcessEnv = {
  PATH: searchPath,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Repository Owner",
  GIT_AUTHOR_EMAIL: "owner@example.com",
  GIT_COMMITTER_NAME: "Repository Owner",
  GIT_COMMITTER_EMAIL: "owner@example.com",
  LC_ALL: "C",
};

export function runGit(gitArguments: string[], workingDirectory: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      gitArguments,
      { cwd: workingDirectory, env: gitEnvironment },
      (error, standardOutput, standardError) => {
        if (error === null) {
          resolve(standardOutput);
          return;
        }
        reject(new Error(`git ${gitArguments.join(" ")} failed: ${standardError}`));
      },
    );
  });
}

/** How a repository names its objects: SHA-1, as every repository GitHub hosts does, or SHA-256. */
export type ObjectFormat = "sha1" | "sha256";

/**
 * Makes a bare repository at `repositoryPath` whose default branch holds
 * `files` in one commit. It serves partial clones, as GitHub does, and
 * accepts pushes over HTTP (the server checks tokens before Git sees them).
 */
export async function createBareRepository(
  repositoryPath: string,
  defaultBranch: string,
  files: Record<string, string>,
  objectFormat: ObjectFormat = "sha1",
): Promise<void> {
  const initialization = ["--initial-branch", defaultBranch, `--object-format=${objectFormat}`];
  await runGit(["init", "--quiet", "--bare", ...initialization, repositoryPath], "/");
  await runGit(["config", "uploadpack.allowFilter", "true"], repositoryPath);
  await runGit(["config", "uploadpack.allowAnySHA1InWant", "true"], repositoryPath);
  await runGit(["config", "http.receivepack", "true"], repositoryPath);
  const workingDirectory = await mkdtemp(path.join(tmpdir(), "barrack-fake-github-seed-"));
  try {
    await runGit(["init", "--quiet", ...initialization], workingDirectory);
    for (const [filePath, contents] of Object.entries(files)) {
      await writeFile(path.join(workingDirectory, filePath), contents);
    }
    await runGit(["add", "--all"], workingDirectory);
    await runGit(["commit", "--quiet", "--message", "Initial commit"], workingDirectory);
    await runGit(
      ["push", "--quiet", repositoryPath, `HEAD:refs/heads/${defaultBranch}`],
      workingDirectory,
    );
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

/** The commit a branch points at, or undefined if there is no such branch. */
export async function readBranch(
  repositoryPath: string,
  branch: string,
): Promise<string | undefined> {
  try {
    return (
      await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repositoryPath)
    ).trim();
  } catch {
    return undefined;
  }
}

/** Adds a commit on a branch from outside Barrack, as another person pushing would. */
export async function pushCommitAsSomeoneElse(
  repositoryPath: string,
  branch: string,
  baseBranch: string,
  fileName: string,
): Promise<string> {
  const workingDirectory = await mkdtemp(path.join(tmpdir(), "barrack-fake-github-other-"));
  try {
    await runGit(
      ["clone", "--quiet", "--branch", baseBranch, repositoryPath, "."],
      workingDirectory,
    );
    const existing = await readBranch(repositoryPath, branch);
    if (existing !== undefined) {
      await runGit(["fetch", "--quiet", "origin", `${branch}:${branch}`], workingDirectory);
      await runGit(["switch", "--quiet", branch], workingDirectory);
    }
    await writeFile(path.join(workingDirectory, fileName), "someone else's work\n");
    await runGit(["add", fileName], workingDirectory);
    await runGit(["commit", "--quiet", "--message", "Someone else's commit"], workingDirectory);
    await runGit(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], workingDirectory);
    return (await runGit(["rev-parse", "HEAD"], workingDirectory)).trim();
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

/** The subjects of the commits on a branch, newest first. */
export async function readCommitSubjects(
  repositoryPath: string,
  branch: string,
): Promise<string[]> {
  const output = await runGit(["log", "--format=%s", `refs/heads/${branch}`], repositoryPath);
  return output.split("\n").filter((line) => line !== "");
}

/** `name <email>` of a commit's author. */
export async function readAuthor(repositoryPath: string, commit: string): Promise<string> {
  return (await runGit(["log", "-1", "--format=%an <%ae>", commit], repositoryPath)).trim();
}
