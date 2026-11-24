import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGithub, type FakeRepository } from "./fake-github.js";

/**
 * The fake's Git server must tell tokens apart as GitHub does, or the tests
 * that rely on it would prove nothing about what a sandbox's token can do.
 */

const { PATH: searchPath } = process.env;

let github: FakeGithub;
let publicRepository: FakeRepository;
let privateRepository: FakeRepository;
let otherRepository: FakeRepository;
let workingDirectory: string;

/** Runs Git with `token` given by a credential helper that reads it from the environment. */
function gitWithToken(
  gitArguments: string[],
  token: string | undefined,
  cwd: string,
): Promise<{ exitCode: number; standardError: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        'credential.helper=!f() { test -n "$TEST_TOKEN" && printf "username=x-access-token\\npassword=%s\\n" "$TEST_TOKEN"; }; f',
        ...gitArguments,
      ],
      {
        cwd,
        env: {
          PATH: searchPath,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_AUTHOR_NAME: "Tester",
          GIT_AUTHOR_EMAIL: "tester@example.com",
          GIT_COMMITTER_NAME: "Tester",
          GIT_COMMITTER_EMAIL: "tester@example.com",
          ...(token === undefined ? {} : { TEST_TOKEN: token }),
        },
      },
      (error, _standardOutput, standardError) => {
        resolve({ exitCode: error === null ? 0 : Number(error.code ?? 1), standardError });
      },
    );
  });
}

async function cloneInto(repository: FakeRepository, token: string | undefined): Promise<string> {
  const directory = await mkdtemp(path.join(workingDirectory, "clone-"));
  const outcome = await gitWithToken(
    ["clone", "--quiet", repository.cloneUrl, "."],
    token,
    directory,
  );
  if (outcome.exitCode !== 0) {
    throw new Error(outcome.standardError);
  }
  return directory;
}

async function pushNewBranch(directory: string, token: string | undefined): Promise<number> {
  await writeFile(path.join(directory, "change.txt"), "change\n");
  await gitWithToken(["add", "change.txt"], token, directory);
  await gitWithToken(["commit", "--quiet", "--message", "Change"], token, directory);
  return (
    await gitWithToken(
      ["push", "--quiet", "origin", "HEAD:refs/heads/barrack/test"],
      token,
      directory,
    )
  ).exitCode;
}

beforeAll(async () => {
  github = await FakeGithub.start();
  workingDirectory = await mkdtemp(path.join(tmpdir(), "barrack-fake-github-test-"));
  publicRepository = await github.createRepository({
    owner: "octo",
    name: "public",
    isPrivate: false,
  });
  privateRepository = await github.createRepository({
    owner: "octo",
    name: "private",
    isPrivate: true,
  });
  otherRepository = await github.createRepository({
    owner: "octo",
    name: "other",
    isPrivate: true,
  });
}, 30_000);

afterAll(async () => {
  await github.close();
  await rm(workingDirectory, { recursive: true, force: true });
});

describe("the fake GitHub's Git server", () => {
  it("lets anyone clone a public repository, and no one push to it without a token", async () => {
    const clone = await cloneInto(publicRepository, undefined);

    expect(await pushNewBranch(clone, undefined)).not.toBe(0);
    expect(await github.readBranch(publicRepository, "barrack/test")).toBeUndefined();
  });

  it("lets a read-only token clone its private repository but not push to it", async () => {
    const readToken = github.issueTokenForTest([privateRepository], { contents: "read" });
    const clone = await cloneInto(privateRepository, readToken);

    expect(await pushNewBranch(clone, readToken)).not.toBe(0);
    expect(await github.readBranch(privateRepository, "barrack/test")).toBeUndefined();
  });

  it("lets a write token push to its repository", async () => {
    const writeToken = github.issueTokenForTest([privateRepository], { contents: "write" });
    const clone = await cloneInto(privateRepository, writeToken);

    expect(await pushNewBranch(clone, writeToken)).toBe(0);
    expect(await github.readBranch(privateRepository, "barrack/test")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses a token for another repository, and no token at all, on a private one", async () => {
    const otherToken = github.issueTokenForTest([otherRepository], { contents: "write" });

    await expect(cloneInto(privateRepository, otherToken)).rejects.toThrow();
    await expect(cloneInto(privateRepository, undefined)).rejects.toThrow();
  });
});
