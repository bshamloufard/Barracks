import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FakeGithub, type FakeRepository, readAuthor } from "@barrack/fake-github";
import { type ThreadEvent, workBranchFor } from "@barrack/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type RunningControlPlane, startControlPlane } from "./support/local-system.js";
import {
  connectGithub,
  createThreadOnRepository,
  findOnlyLocalWorkspace,
  publishThread,
} from "./support/repositories-api.js";
import { TestClient } from "./support/test-client.js";
import { waitUntilSandboxIsReady } from "./support/threads-api.js";

/**
 * A thread on a Git repository, through the real control plane and
 * supervisor with local-process sandboxes and the fake agent, against a
 * fake GitHub: linking GitHub, cloning a private repository with
 * credentials the sandbox asks for, publishing the work branch and opening
 * one pull request, and what happens with a public repository and a clone
 * that fails. The Docker test does the same with the real Pi as its own
 * user; this one checks the plumbing quickly, with the test standing in for
 * the agent's commits.
 */

const { PATH: searchPath } = process.env;

let github: FakeGithub;
let privateRepository: FakeRepository;
let publicRepository: FakeRepository;
let controlPlane: RunningControlPlane;
const clients: TestClient[] = [];

/** Git as the agent would run it in its workspace: the repository's own configuration, nothing else. */
function gitInWorkspace(workspace: string, gitArguments: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      gitArguments,
      {
        cwd: workspace,
        env: { PATH: searchPath, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      },
      (error, standardOutput, standardError) =>
        error === null ? resolve(standardOutput) : reject(new Error(standardError)),
    );
  });
}

async function commitInWorkspace(workspace: string, fileName: string): Promise<string> {
  await writeFile(path.join(workspace, fileName), `${fileName}\n`);
  await gitInWorkspace(workspace, ["add", fileName]);
  await gitInWorkspace(workspace, ["commit", "--quiet", "--message", `Add ${fileName}`]);
  return (await gitInWorkspace(workspace, ["rev-parse", "HEAD"])).trim();
}

async function watch(threadId: string): Promise<TestClient> {
  const client = await TestClient.connect(controlPlane, threadId, 0);
  clients.push(client);
  return client;
}

function eventsOf(client: TestClient): ThreadEvent[] {
  return client.threadEvents().map(({ event }) => event);
}

function hasEvent(type: ThreadEvent["type"], count = 1) {
  return (messages: readonly unknown[]) =>
    messages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "event" in message &&
        (message.event as ThreadEvent).type === type,
    ).length >= count;
}

beforeAll(async () => {
  github = await FakeGithub.start();
  privateRepository = await github.createRepository({
    owner: "octo",
    name: "app",
    isPrivate: true,
    files: { "README.md": "# App\n", "notes.txt": "private notes\n" },
  });
  publicRepository = await github.createRepository({
    owner: "octo",
    name: "public",
    isPrivate: false,
  });
  github.addUser({
    login: "octocat",
    name: "Octo Cat",
    push: [privateRepository, publicRepository],
  });
  github.installApp([privateRepository]);
  controlPlane = await startControlPlane({
    sandboxes: { kind: "local-process" },
    environment: github.controlPlaneEnvironment(),
  });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

afterAll(async () => {
  await controlPlane?.stop();
  await github?.close();
});

describe("a thread on a repository", () => {
  it("clones a private repository through the App, and publishes its branch with one pull request however often it is published", async () => {
    const connection = await connectGithub(controlPlane, github, "octocat");
    expect(connection).toMatchObject({
      state: "connected",
      login: "octocat",
      repositories: [{ fullName: "octo/app", isPrivate: true }],
    });

    const thread = await createThreadOnRepository(controlPlane, {
      url: privateRepository.cloneUrl,
      access: "github_app",
    });
    await waitUntilSandboxIsReady(controlPlane, thread.threadId);
    const client = await watch(thread.threadId);
    await client.waitUntil("the clone", hasEvent("repository_cloned"));
    const workBranch = workBranchFor(thread.threadId);
    expect(eventsOf(client)).toEqual([
      {
        type: "repository_clone_started",
        repositoryUrl: privateRepository.cloneUrl,
        baseBranch: "main",
      },
      {
        type: "repository_cloned",
        baseBranch: "main",
        baseCommit: await github.readBranch(privateRepository, "main"),
        workBranch,
        lostEarlierWork: false,
      },
    ]);

    const workspace = await findOnlyLocalWorkspace(controlPlane.sandboxesDirectory ?? "");
    expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("private notes\n");
    expect((await gitInWorkspace(workspace, ["branch", "--show-current"])).trim()).toBe(workBranch);
    const firstCommit = await commitInWorkspace(workspace, "first.txt");

    const firstPublication = await publishThread(controlPlane, thread.threadId, true);
    expect(firstPublication).toEqual({
      workBranch,
      commit: firstCommit,
      branchUrl: `${privateRepository.htmlUrl}/tree/${workBranch}`,
      pullRequestUrl: `${privateRepository.htmlUrl}/pull/1`,
    });
    expect(await github.readBranch(privateRepository, workBranch)).toBe(firstCommit);
    expect(await readAuthor(privateRepository.directory, firstCommit)).toMatch(
      /^Octo Cat <\d+\+octocat@users\.noreply\.github\.com>$/,
    );

    const secondCommit = await commitInWorkspace(workspace, "second.txt");
    const secondPublication = await publishThread(controlPlane, thread.threadId, true);
    expect(secondPublication).toMatchObject({
      commit: secondCommit,
      pullRequestUrl: firstPublication && `${privateRepository.htmlUrl}/pull/1`,
    });
    expect(await github.readBranch(privateRepository, workBranch)).toBe(secondCommit);
    expect(github.pullRequests).toEqual([
      expect.objectContaining({ number: 1, head: workBranch, base: "main" }),
    ]);
    await client.waitUntil("both publications", hasEvent("repository_published", 2));
    expect(eventsOf(client).filter((event) => event.type === "repository_published")).toEqual([
      expect.objectContaining({ commit: firstCommit, isPullRequestNew: true }),
      expect.objectContaining({ commit: secondCommit, isPullRequestNew: false }),
    ]);
    expect(await github.readBranch(privateRepository, "main")).toBe(
      (eventsOf(client)[1] as { baseCommit: string }).baseCommit,
    );

    // The sandbox only ever got read-only tokens for this one repository;
    // write-capable ones were minted for the control plane's own pushes.
    const sandboxTokens = github.issuedTokens.filter(
      (token) => token.permissions.contents === "read",
    );
    expect(sandboxTokens.length).toBeGreaterThan(0);
    for (const token of sandboxTokens) {
      expect(token.repositoryIds).toEqual([privateRepository.id]);
      expect(token.permissions).toEqual({ contents: "read", metadata: "read" });
    }
    // No token is anywhere it could be read back: the repository's
    // configuration, the thread's history, or anything either service logged.
    const gitConfiguration = await readFile(path.join(workspace, ".git/config"), "utf8");
    const history = JSON.stringify(client.messages);
    const logs = controlPlane.process.describeOutput();
    for (const { token } of github.issuedTokens) {
      expect(gitConfiguration).not.toContain(token);
      expect(history).not.toContain(token);
      expect(logs).not.toContain(token);
    }
  });

  it("clones a public repository without credentials, and says publishing is not available", async () => {
    const thread = await createThreadOnRepository(controlPlane, {
      url: publicRepository.cloneUrl,
      access: "none",
    });
    await waitUntilSandboxIsReady(controlPlane, thread.threadId);
    const client = await watch(thread.threadId);
    await client.waitUntil("the clone", hasEvent("repository_cloned"));

    expect(thread.repository).toMatchObject({
      access: "none",
      publishing: { isAvailable: false, reason: expect.stringContaining("cannot push") },
    });
    expect(await publishThread(controlPlane, thread.threadId, true)).toMatchObject({
      status: 409,
      errorCode: "conflict",
    });
  });

  it("reports a clone that fails, and gives the agent no message while the repository is missing", async () => {
    const thread = await createThreadOnRepository(controlPlane, {
      url: privateRepository.cloneUrl,
      access: "none",
    });
    await waitUntilSandboxIsReady(controlPlane, thread.threadId);
    const client = await watch(thread.threadId);
    await client.waitUntil("the failed clone", hasEvent("repository_clone_failed"));

    client.send({ type: "send_user_message", text: "Please start" });
    await client.waitUntil("a second failed clone", hasEvent("repository_clone_failed", 2));
    await client.waitUntil("the message to count as delivered", (messages) =>
      messages.some(
        (message) =>
          message.type === "user_message_delivery_status" && message.deliveredThroughSequence > 0,
      ),
    );

    const failure = eventsOf(client).find((event) => event.type === "repository_clone_failed");
    expect(failure).toMatchObject({
      errorMessage: expect.stringContaining(privateRepository.cloneUrl),
    });
    expect(eventsOf(client).some((event) => event.type === "agent_run_started")).toBe(false);
  });
});
