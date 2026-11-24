import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FakeGithub,
  type FakeRepository,
  pushCommitAsSomeoneElse,
  runGit,
} from "@barrack/fake-github";
import {
  apiErrorResponseSchema,
  buildPublishThreadApiPath,
  type CreatePublicationBundle,
  type ThreadEvent,
  threadResponseSchema,
  threadsApiPath,
  workBranchFor,
} from "@barrack/protocol";
import { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { githubSettingsFor, linkGithub } from "../test-support/github-test-setup.js";
import { browserHeaders, TestControlPlane } from "../test-support/test-control-plane.js";
import type { FakeSupervisor } from "../test-support/test-peers.js";

/**
 * Publishing a thread's work branch, through the real control plane against
 * the fake GitHub, with a fake supervisor that uploads whatever bundle the
 * test makes: a well-formed one, and the hostile ones a sandbox could send.
 * Only `barrack/<thread>` is ever pushed, never over someone else's commits,
 * and one pull request is opened however often the branch is published.
 */

const ada = { userId: "11111111-1111-4111-8111-111111111111", email: "ada@example.com" };
const grace = { userId: "22222222-2222-4222-8222-222222222222", email: "grace@example.com" };
const maximumBundleSizeInBytes = 64 * 1024;
const { PATH: searchPath } = process.env;

let github: FakeGithub;
let issuer: TestIdentityIssuer;
let controlPlane: TestControlPlane;
let repository: FakeRepository;
let adaToken: string;
let scratch: string;
let repositoryCount = 0;

type PublishingThread = {
  threadId: string;
  workBranch: string;
  supervisor: FakeSupervisor;
  clone: string;
  baseCommit: string;
};

beforeAll(async () => {
  github = await FakeGithub.start();
}, 30_000);

afterAll(async () => {
  await github.close();
});

beforeEach(async () => {
  repositoryCount += 1;
  repository = await github.createRepository({
    owner: "octo",
    name: `app-${repositoryCount}`,
    isPrivate: true,
    files: { "README.md": "# App\n" },
  });
  github.addUser({ login: "octocat", name: "Octo Cat", push: [repository] });
  github.installApp([repository]);
  issuer = await TestIdentityIssuer.start();
  controlPlane = await TestControlPlane.start({
    authentication: { kind: "test-issuer", issuer },
    github: githubSettingsFor(github),
    maximumBundleSizeInBytes,
  });
  adaToken = await issuer.mintAccessToken(ada);
  await linkGithub(controlPlane, github, "octocat", adaToken);
  scratch = await mkdtemp(path.join(tmpdir(), "barrack-publication-test-"));
});

afterEach(async () => {
  await controlPlane.close();
  await issuer.close();
  await rm(scratch, { recursive: true, force: true });
});

async function createThreadOnRepository(accessToken: string): Promise<Response> {
  return controlPlane.postThread(
    browserHeaders(accessToken),
    JSON.stringify({ repository: { url: repository.cloneUrl, access: "github_app" } }),
  );
}

/** A thread on the repository with its fake supervisor attached, and a clone standing in for its workspace. */
async function startPublishingThread(): Promise<PublishingThread> {
  const response = await createThreadOnRepository(adaToken);
  expect(response.status).toBe(201);
  const { threadId } = threadResponseSchema.parse(await response.json()).thread;
  await controlPlane.whenOperationsSettle();
  const supervisor = await controlPlane.connectSupervisor({
    threadId,
    supervisorToken: controlPlane.supervisorTokenGivenFor(threadId),
  });
  const workBranch = workBranchFor(threadId);
  const clone = await mkdtemp(path.join(scratch, "clone-"));
  await runGit(["clone", "--quiet", repository.directory, "."], clone);
  await runGit(["switch", "--quiet", "--create", workBranch], clone);
  const baseCommit = (await runGit(["rev-parse", "HEAD"], clone)).trim();
  return { threadId, workBranch, supervisor, clone, baseCommit };
}

async function commit(
  clone: string,
  fileName: string,
  contents = `${fileName}\n`,
): Promise<string> {
  await writeFile(path.join(clone, fileName), contents);
  await runGit(["add", fileName], clone);
  await runGit(["commit", "--quiet", "--message", `Add ${fileName}`], clone);
  return (await runGit(["rev-parse", "HEAD"], clone)).trim();
}

async function bundleOf(clone: string, revisions: string[]): Promise<Buffer> {
  const bundlePath = path.join(scratch, `${randomBytes(4).toString("hex")}.bundle`);
  await runGit(["bundle", "create", "--quiet", bundlePath, ...revisions], clone);
  return readFile(bundlePath);
}

function upload(request: CreatePublicationBundle, bundle: Buffer, supervisorToken: string) {
  return fetch(`${controlPlane.httpBaseUrl}${request.uploadPath}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${supervisorToken}` },
    body: new Uint8Array(bundle),
  });
}

/**
 * Asks to publish, answers the control plane's request for a bundle with
 * `bundle`, uploaded with the thread's supervisor token, and returns what
 * the publication request was answered.
 */
async function publish(
  thread: PublishingThread,
  bundle: Buffer,
  openPullRequest = true,
): Promise<{ status: number; body: unknown }> {
  const requestsBefore = bundleRequests(thread).length;
  const answer = fetch(`${controlPlane.httpBaseUrl}${buildPublishThreadApiPath(thread.threadId)}`, {
    method: "POST",
    headers: browserHeaders(adaToken),
    body: JSON.stringify({ openPullRequest }),
  });
  await thread.supervisor.inbox.waitUntil(
    "a request for a bundle",
    () => bundleRequests(thread).length > requestsBefore,
  );
  const request = bundleRequests(thread).at(-1) as CreatePublicationBundle;
  await upload(request, bundle, controlPlane.supervisorTokenGivenFor(thread.threadId));
  const response = await answer;
  return { status: response.status, body: await response.json() };
}

function bundleRequests(thread: PublishingThread): CreatePublicationBundle[] {
  return thread.supervisor.inbox.messages.filter(
    (message) => message.type === "create_publication_bundle",
  );
}

async function recordedRepositoryEvents(threadId: string): Promise<ThreadEvent[]> {
  const events = await controlPlane.threadEventLog.readEvents(threadId, {
    afterSequence: 0,
    throughSequence: Number.MAX_SAFE_INTEGER,
    limit: 100,
  });
  return events.map(({ event }) => event).filter((event) => event.type.startsWith("repository_"));
}

function errorOf(body: unknown) {
  return apiErrorResponseSchema.parse(body).error;
}

describe("publishing a thread's branch", () => {
  it("tells the supervisor the repository to clone and who the agent's commits are by", async () => {
    const thread = await startPublishingThread();

    const preparation = await thread.supervisor.inbox.waitFor(
      "the workspace's description",
      (message) => message.type === "prepare_workspace",
    );

    expect(preparation).toEqual({
      type: "prepare_workspace",
      repository: {
        url: repository.cloneUrl,
        access: "github_app",
        baseBranch: "main",
        workBranch: thread.workBranch,
        commitAuthor: {
          name: "Octo Cat",
          email: expect.stringMatching(/^\d+\+octocat@users\.noreply\.github\.com$/),
        },
      },
      agentHasWorkedBefore: false,
    });
  });

  it("pushes only the thread's branch, and opens one pull request however often it is published", async () => {
    const thread = await startPublishingThread();
    const mainBefore = await github.readBranch(repository, "main");

    const first = await commit(thread.clone, "first.txt");
    const firstAnswer = await publish(
      thread,
      await bundleOf(thread.clone, [`${thread.baseCommit}..${thread.workBranch}`]),
    );
    const second = await commit(thread.clone, "second.txt");
    const secondAnswer = await publish(
      thread,
      await bundleOf(thread.clone, [`${thread.baseCommit}..${thread.workBranch}`]),
    );

    expect(firstAnswer).toMatchObject({
      status: 200,
      body: { commit: first, pullRequestUrl: `${repository.htmlUrl}/pull/1` },
    });
    expect(secondAnswer).toMatchObject({
      status: 200,
      body: { commit: second, pullRequestUrl: `${repository.htmlUrl}/pull/1` },
    });
    expect(await github.readBranch(repository, thread.workBranch)).toBe(second);
    expect(await github.readBranch(repository, "main")).toBe(mainBefore);
    expect(github.pullRequests.filter((pull) => pull.head === thread.workBranch)).toEqual([
      expect.objectContaining({
        base: "main",
        title: `Changes from Barrack thread ${thread.threadId}`,
      }),
    ]);
    expect(await recordedRepositoryEvents(thread.threadId)).toEqual([
      expect.objectContaining({
        type: "repository_published",
        commit: first,
        isPullRequestNew: true,
      }),
      expect.objectContaining({
        type: "repository_published",
        commit: second,
        isPullRequestNew: false,
      }),
    ]);
  });

  it("replaces commits it published itself when the agent rewrote them", async () => {
    const thread = await startPublishingThread();
    await commit(thread.clone, "draft.txt");
    await publish(
      thread,
      await bundleOf(thread.clone, [`${thread.baseCommit}..${thread.workBranch}`]),
      false,
    );
    await runGit(["commit", "--quiet", "--amend", "--message", "Reworded"], thread.clone);
    const rewritten = (await runGit(["rev-parse", "HEAD"], thread.clone)).trim();

    const answer = await publish(
      thread,
      await bundleOf(thread.clone, [`${thread.baseCommit}..${thread.workBranch}`]),
      false,
    );

    expect(answer).toMatchObject({
      status: 200,
      body: { commit: rewritten, pullRequestUrl: null },
    });
    expect(await github.readBranch(repository, thread.workBranch)).toBe(rewritten);
    expect(github.pullRequests.filter((pull) => pull.head === thread.workBranch)).toEqual([]);
  });

  it("never overwrites commits someone else pushed to the thread's branch", async () => {
    const thread = await startPublishingThread();
    await commit(thread.clone, "agent.txt");
    const theirs = await pushCommitAsSomeoneElse(
      repository.directory,
      thread.workBranch,
      "main",
      "theirs.txt",
    );

    const answer = await publish(
      thread,
      await bundleOf(thread.clone, [`${thread.baseCommit}..${thread.workBranch}`]),
    );

    expect(answer.status).toBe(409);
    expect(errorOf(answer.body)).toMatchObject({
      code: "publication_failed",
      message: expect.stringContaining("did not push"),
    });
    expect(await github.readBranch(repository, thread.workBranch)).toBe(theirs);
    expect(await recordedRepositoryEvents(thread.threadId)).toEqual([
      {
        type: "repository_publication_failed",
        errorMessage: expect.stringContaining("did not push"),
      },
    ]);
  });

  it("refuses a bundle that would update any other branch", async () => {
    const thread = await startPublishingThread();
    await commit(thread.clone, "agent.txt");
    await runGit(["switch", "--quiet", "main"], thread.clone);
    await commit(thread.clone, "on-main.txt");
    const mainBefore = await github.readBranch(repository, "main");

    const answer = await publish(
      thread,
      await bundleOf(thread.clone, [`^${thread.baseCommit}`, thread.workBranch, "main"]),
    );

    expect(errorOf(answer.body)).toMatchObject({
      code: "publication_failed",
      message: expect.stringContaining("exactly one reference"),
    });
    expect(await github.readBranch(repository, "main")).toBe(mainBefore);
    expect(await github.readBranch(repository, thread.workBranch)).toBeUndefined();
  });

  it("refuses a bundle naming only another branch", async () => {
    const thread = await startPublishingThread();
    await runGit(["switch", "--quiet", "main"], thread.clone);
    await commit(thread.clone, "on-main.txt");

    const answer = await publish(
      thread,
      await bundleOf(thread.clone, [`${thread.baseCommit}..main`]),
    );

    expect(answer.status).toBe(409);
    expect(await github.readBranch(repository, "main")).not.toBe(
      (await runGit(["rev-parse", "HEAD"], thread.clone)).trim(),
    );
  });

  it("refuses something that is not a Git bundle", async () => {
    const thread = await startPublishingThread();

    const answer = await publish(thread, Buffer.from("# v2 git bundle\nnot really\n\nPACKjunk"));

    expect(errorOf(answer.body)).toMatchObject({ code: "publication_failed" });
    expect(await github.readBranch(repository, thread.workBranch)).toBeUndefined();
  });

  it("refuses a bundle larger than allowed", async () => {
    const thread = await startPublishingThread();
    await commit(
      thread.clone,
      "large.bin",
      randomBytes(maximumBundleSizeInBytes * 2).toString("base64"),
    );

    const answer = await publish(
      thread,
      await bundleOf(thread.clone, [`${thread.baseCommit}..${thread.workBranch}`]),
    );

    expect(errorOf(answer.body)).toMatchObject({
      code: "publication_failed",
      message: expect.stringContaining("bytes"),
    });
    expect(await github.readBranch(repository, thread.workBranch)).toBeUndefined();
  });

  it("refuses commits whose trees would plant Git's own directory, hooks and configuration in a checkout", async () => {
    const thread = await startPublishingThread();
    const blobPath = path.join(scratch, "hook");
    await writeFile(blobPath, "#!/bin/sh\ntouch /tmp/pwned\n");
    const blob = (await runGit(["hash-object", "-w", blobPath], thread.clone)).trim();
    const hooks = (
      await runGitWithInput(thread.clone, ["mktree"], `100755 blob ${blob}\tpost-checkout\n`)
    ).trim();
    const dotGit = (
      await runGitWithInput(thread.clone, ["mktree"], `040000 tree ${hooks}\thooks\n`)
    ).trim();
    const root = (
      await runGitWithInput(thread.clone, ["mktree"], `040000 tree ${dotGit}\t.git\n`)
    ).trim();
    const evil = (
      await runGit(["commit-tree", root, "-p", thread.baseCommit, "-m", "evil"], thread.clone)
    ).trim();
    await runGit(["update-ref", `refs/heads/${thread.workBranch}`, evil], thread.clone);

    const answer = await publish(
      thread,
      await bundleOf(thread.clone, [`${thread.baseCommit}..${thread.workBranch}`]),
    );

    expect(errorOf(answer.body)).toMatchObject({
      code: "publication_failed",
      message: expect.stringContaining(".git"),
    });
    expect(await github.readBranch(repository, thread.workBranch)).toBeUndefined();
  });

  it("takes an upload only with the thread's supervisor token, and only for a publication under way", async () => {
    const thread = await startPublishingThread();
    const other = await startPublishingThread();
    const request = {
      type: "create_publication_bundle" as const,
      publicationId: "not-under-way",
      uploadPath: `/threads/${thread.threadId}/supervisor/publication-bundles/not-under-way`,
      maximumSizeInBytes: 10,
    };

    const withoutToken = await upload(request, Buffer.from("x"), "wrong");
    const withAnotherThreadsToken = await upload(
      request,
      Buffer.from("x"),
      controlPlane.supervisorTokenGivenFor(other.threadId),
    );
    const notUnderWay = await upload(
      request,
      Buffer.from("x"),
      controlPlane.supervisorTokenGivenFor(thread.threadId),
    );

    expect([withoutToken.status, withAnotherThreadsToken.status, notUnderWay.status]).toEqual([
      401, 401, 404,
    ]);
  });

  it("is refused, before the sandbox is asked anything, once GitHub says the user can no longer push", async () => {
    const thread = await startPublishingThread();
    github.revokePush("octocat", repository);

    const response = await fetch(
      `${controlPlane.httpBaseUrl}${buildPublishThreadApiPath(thread.threadId)}`,
      {
        method: "POST",
        headers: browserHeaders(adaToken),
        body: JSON.stringify({ openPullRequest: true }),
      },
    );

    expect(response.status).toBe(409);
    expect(errorOf(await response.json()).message).toContain("can no longer push");
    expect(bundleRequests(thread)).toEqual([]);
  });

  it("answers another user's thread as missing", async () => {
    const thread = await startPublishingThread();
    const graceToken = await issuer.mintAccessToken(grace);

    const response = await fetch(
      `${controlPlane.httpBaseUrl}${buildPublishThreadApiPath(thread.threadId)}`,
      {
        method: "POST",
        headers: browserHeaders(graceToken),
        body: JSON.stringify({ openPullRequest: true }),
      },
    );

    expect(response.status).toBe(404);
    expect(bundleRequests(thread)).toEqual([]);
  });
});

describe("creating a thread on a repository", () => {
  it("is refused for a user not verified for the repository", async () => {
    const graceToken = await issuer.mintAccessToken(grace);

    const response = await createThreadOnRepository(graceToken);

    expect(response.status).toBe(403);
    expect(errorOf(await response.json())).toMatchObject({ code: "repository_not_allowed" });
  });

  it("is refused once GitHub says the user can no longer push, though they were verified before", async () => {
    github.revokePush("octocat", repository);

    const response = await createThreadOnRepository(adaToken);

    expect(response.status).toBe(403);
    expect(errorOf(await response.json()).message).toContain("can no longer push");
  });

  it("is refused for a repository URL Barrack does not accept", async () => {
    const response = await controlPlane.postThread(
      browserHeaders(adaToken),
      JSON.stringify({ repository: { url: "file:///etc", access: "none" } }),
    );

    expect(response.status).toBe(400);
    const listed = await controlPlane.getApi(threadsApiPath, adaToken);
    expect(await listed.json()).toEqual({ threads: [] });
  });
});

/** Git reading `input` on its standard input, as `mktree` does. */
function runGitWithInput(
  workingDirectory: string,
  gitArguments: string[],
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      gitArguments,
      {
        cwd: workingDirectory,
        env: { PATH: searchPath, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
      (error, standardOutput, standardError) =>
        error === null ? resolve(standardOutput) : reject(new Error(standardError)),
    );
    child.stdin?.end(input);
  });
}
