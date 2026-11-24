import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
  buildPublicationBundleUploadPath,
  buildPublishThreadApiPath,
  buildStopThreadApiPath,
  buildThreadApiPath,
  type CreatePublicationBundle,
  type ThreadEvent,
  threadResponseSchema,
  threadsApiPath,
  workBranchFor,
} from "@barrack/protocol";
import { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { githubSettingsFor, linkGithub } from "../test-support/github-test-setup.js";
import { buildDeltaBombPack, wrapPackInBundle } from "../test-support/hostile-packs.js";
import {
  browserHeaders,
  TestControlPlane,
  type TestControlPlaneOptions,
} from "../test-support/test-control-plane.js";
import type { FakeSupervisor } from "../test-support/test-peers.js";
import { defaultGitChildLimits, type GitChildLimits } from "./git-child-limits.js";

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
  adaToken = await issuer.mintAccessToken(ada);
  await startControlPlane();
  scratch = await mkdtemp(path.join(tmpdir(), "barrack-publication-test-"));
});

/** A control plane linked to Ada's GitHub account, with `options` beside the usual ones. */
async function startControlPlane(options: Partial<TestControlPlaneOptions> = {}): Promise<void> {
  controlPlane = await TestControlPlane.start({
    authentication: { kind: "test-issuer", issuer },
    github: githubSettingsFor(github),
    maximumBundleSizeInBytes,
    ...options,
  });
  await linkGithub(controlPlane, github, "octocat", adaToken);
}

/** Replaces the test's control plane with one publishing under `gitChildLimits`. */
async function restartWithLimits(gitChildLimits: Partial<GitChildLimits>): Promise<void> {
  await controlPlane.close();
  await startControlPlane({ gitChildLimits: { ...defaultGitChildLimits, ...gitChildLimits } });
}

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
  const { answer, request } = await askToPublish(thread, openPullRequest);
  await upload(request, bundle, controlPlane.supervisorTokenGivenFor(thread.threadId));
  return answer;
}

/** Asks to publish, and returns the bundle the control plane then asks the supervisor for, and the answer to come. */
async function askToPublish(
  thread: PublishingThread,
  openPullRequest = true,
): Promise<{
  answer: Promise<{ status: number; body: unknown }>;
  request: CreatePublicationBundle;
}> {
  const requestsBefore = bundleRequests(thread).length;
  const answer = fetch(`${controlPlane.httpBaseUrl}${buildPublishThreadApiPath(thread.threadId)}`, {
    method: "POST",
    headers: browserHeaders(adaToken),
    body: JSON.stringify({ openPullRequest }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  await thread.supervisor.inbox.waitUntil(
    "a request for a bundle",
    () => bundleRequests(thread).length > requestsBefore,
  );
  return { answer, request: bundleRequests(thread).at(-1) as CreatePublicationBundle };
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
      message: expect.stringContaining("holds commits someone else pushed"),
    });
    expect(await github.readBranch(repository, thread.workBranch)).toBe(theirs);
    expect(await recordedRepositoryEvents(thread.threadId)).toEqual([
      {
        type: "repository_publication_failed",
        errorMessage: expect.stringContaining("holds commits someone else pushed"),
      },
    ]);
  });

  it("adds the agent's commits on top of someone else's, as a fast-forward", async () => {
    const thread = await startPublishingThread();
    const theirs = await pushCommitAsSomeoneElse(
      repository.directory,
      thread.workBranch,
      "main",
      "theirs.txt",
    );
    await takeBranchFromRepository(thread);
    const ours = await commit(thread.clone, "ours.txt");

    const answer = await publish(thread, await bundleSinceBase(thread), false);

    expect(answer).toMatchObject({ status: 200, body: { commit: ours } });
    expect(await github.readBranch(repository, thread.workBranch)).toBe(ours);
    expect(await commitIsAncestor(theirs, ours)).toBe(true);
  });

  it("refuses to drop someone else's commit from beneath one Barrack pushed on top of it", async () => {
    const thread = await startPublishingThread();
    await pushCommitAsSomeoneElse(repository.directory, thread.workBranch, "main", "theirs.txt");
    await takeBranchFromRepository(thread);
    await commit(thread.clone, "ours.txt");
    await publish(thread, await bundleSinceBase(thread), false);
    const published = await github.readBranch(repository, thread.workBranch);
    await runGit(["reset", "--quiet", "--hard", thread.baseCommit], thread.clone);
    await commit(thread.clone, "rewritten.txt");

    const answer = await publish(thread, await bundleSinceBase(thread), false);

    expect(errorOf(answer.body).message).toContain("holds commits someone else pushed");
    expect(await github.readBranch(repository, thread.workBranch)).toBe(published);
  });

  it("never takes someone else's commit it found on the branch for its own, so cannot then overwrite it", async () => {
    const thread = await startPublishingThread();
    const theirs = await pushCommitAsSomeoneElse(
      repository.directory,
      thread.workBranch,
      "main",
      "theirs.txt",
    );
    await takeBranchFromRepository(thread);
    const adopted = await publish(thread, await bundleSinceBase(thread), false);
    await runGit(["reset", "--quiet", "--hard", thread.baseCommit], thread.clone);
    await commit(thread.clone, "mine.txt");

    const overwrite = await publish(thread, await bundleSinceBase(thread), false);

    expect(adopted).toMatchObject({ status: 200, body: { commit: theirs } });
    expect(errorOf(overwrite.body).message).toContain("holds commits someone else pushed");
    expect(await github.readBranch(repository, thread.workBranch)).toBe(theirs);
  });

  it("pushes nothing when someone pushes to the branch between the check and the push", async () => {
    const thread = await startPublishingThread();
    await commit(thread.clone, "first.txt");
    await publish(thread, await bundleSinceBase(thread), false);
    await commit(thread.clone, "second.txt");
    const heldPush = github.holdNextGitRequest("push");

    const answering = publish(thread, await bundleSinceBase(thread), false);
    await heldPush.reached;
    const theirs = await pushCommitAsSomeoneElse(
      repository.directory,
      thread.workBranch,
      "main",
      "theirs.txt",
    );
    heldPush.release();
    const answer = await answering;

    expect(errorOf(answer.body).message).toContain(
      `pushed to ${thread.workBranch} while Barrack was publishing`,
    );
    expect(await github.readBranch(repository, thread.workBranch)).toBe(theirs);
  });

  it("finishes a publication whose push went through but was never recorded", async () => {
    const thread = await startPublishingThread();
    const agentCommit = await commit(thread.clone, "agent.txt");
    await runGit(
      ["push", "--quiet", repository.directory, `${thread.workBranch}:${thread.workBranch}`],
      thread.clone,
    );

    const answer = await publish(
      thread,
      await bundleOf(thread.clone, [`${thread.baseCommit}..${thread.workBranch}`]),
      false,
    );

    expect(answer).toMatchObject({ status: 200, body: { commit: agentCommit } });
    expect(await github.readBranch(repository, thread.workBranch)).toBe(agentCommit);
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

  it("takes an upload only with the thread's supervisor token, and only for a publication under way, refusing an unknown thread as a wrong token", async () => {
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
    const toAThreadThatDoesNotExist = await upload(
      {
        ...request,
        uploadPath: buildPublicationBundleUploadPath(randomUUID(), request.publicationId),
      },
      Buffer.from("x"),
      controlPlane.supervisorTokenGivenFor(thread.threadId),
    );

    expect([
      withoutToken.status,
      withAnotherThreadsToken.status,
      notUnderWay.status,
      toAThreadThatDoesNotExist.status,
    ]).toEqual([401, 401, 404, 401]);
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

/**
 * A thread deleted, or its sandbox stopped, while its branch is being
 * published: nothing is pushed or recorded for a thread being deleted, and
 * a publication still waiting for a stopping sandbox's bundle fails at once.
 */
describe("publishing while the thread ends", () => {
  async function deleteThread(thread: PublishingThread): Promise<void> {
    const response = await controlPlane.sendApi(
      "DELETE",
      buildThreadApiPath(thread.threadId),
      adaToken,
    );
    expect(response.status).toBe(202);
    await controlPlane.whenOperationsSettle();
  }

  it("abandons a publication waiting for its bundle when the thread is deleted, at once, recording nothing", async () => {
    const thread = await startPublishingThread();
    await commit(thread.clone, "agent.txt");
    const { answer, request } = await askToPublish(thread);

    await deleteThread(thread);
    const lateUpload = await upload(
      request,
      await bundleSinceBase(thread),
      controlPlane.supervisorTokenGivenFor(thread.threadId),
    );

    expect(errorOf((await answer).body).message).toBe(
      "This thread is being deleted, so its branch was not published.",
    );
    expect(lateUpload.status).toBe(401);
    expect(await controlPlane.threadStore.find(thread.threadId)).toBeUndefined();
    expect(await recordedRepositoryEvents(thread.threadId)).toEqual([]);
    expect(await github.readBranch(repository, thread.workBranch)).toBeUndefined();
  });

  it("abandons a publication that has its bundle when the thread is deleted, pushing nothing", async () => {
    const thread = await startPublishingThread();
    await commit(thread.clone, "agent.txt");
    const heldFetch = github.holdNextGitRequest("fetch");
    const { answer, request } = await askToPublish(thread);
    await upload(
      request,
      await bundleSinceBase(thread),
      controlPlane.supervisorTokenGivenFor(thread.threadId),
    );
    await heldFetch.reached;

    await deleteThread(thread);
    heldFetch.release();

    expect(errorOf((await answer).body).message).toBe(
      "This thread is being deleted, so its branch was not published.",
    );
    expect(await recordedRepositoryEvents(thread.threadId)).toEqual([]);
    expect(await github.readBranch(repository, thread.workBranch)).toBeUndefined();
  });

  it("fails a publication still waiting for its bundle as soon as the sandbox begins stopping, saying why", async () => {
    const thread = await startPublishingThread();
    const { answer } = await askToPublish(thread);

    const stopped = await controlPlane.sendApi(
      "POST",
      buildStopThreadApiPath(thread.threadId),
      adaToken,
    );
    await controlPlane.whenOperationsSettle();

    const failure =
      "The thread's sandbox is stopping, so it cannot send the branch's commits. Resume the thread, then publish again.";
    expect(stopped.status).toBe(202);
    expect(errorOf((await answer).body).message).toBe(failure);
    expect(await recordedRepositoryEvents(thread.threadId)).toEqual([
      { type: "repository_publication_failed", errorMessage: failure },
    ]);
  });
});

/**
 * What a hostile bundle or repository can make the control plane's Git use
 * is bounded, and going over a bound fails the publication, saying which,
 * and nothing else.
 */
describe("publishing within limits", () => {
  const isLinux = process.platform === "linux";
  const someCommit = "1".repeat(40);

  it.skipIf(!isLinux)(
    "refuses a pack of a few kilobytes that would make Git build a 2 GiB object in memory, at once",
    async () => {
      const thread = await startPublishingThread();
      const pack = buildDeltaBombPack(2 * 1024 * 1024 * 1024);
      const startedAt = Date.now();

      const answer = await publish(
        thread,
        wrapPackInBundle(`refs/heads/${thread.workBranch}`, someCommit, pack),
      );

      expect(pack.length).toBeLessThan(maximumBundleSizeInBytes);
      expect(errorOf(answer.body)).toMatchObject({
        code: "publication_failed",
        message: expect.stringContaining("needed more memory than a publication may use"),
      });
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(await github.readBranch(repository, thread.workBranch)).toBeUndefined();
    },
  );

  it("stops Git once it has used its processor time, on deltas each costly to rebuild", async () => {
    await restartWithLimits({ processorSeconds: 1 });
    const thread = await startPublishingThread();
    const pack = buildDeltaBombPack(256 * 1024 * 1024, 8);

    const answer = await publish(
      thread,
      wrapPackInBundle(`refs/heads/${thread.workBranch}`, someCommit, pack),
    );

    expect(errorOf(answer.body).message).toContain(
      "needed more processor time than a publication may use (1 seconds)",
    );
    expect(await github.readBranch(repository, thread.workBranch)).toBeUndefined();
  }, 60_000);

  it("stops Git writing more than the publication's disk allows", async () => {
    await restartWithLimits({ diskInBytes: 16 * 1024 });
    const thread = await startPublishingThread();
    await commit(thread.clone, "random.bin", randomBytes(24 * 1024).toString("base64"));

    const answer = await publish(
      thread,
      await bundleOf(thread.clone, [`${thread.baseCommit}..${thread.workBranch}`]),
    );

    expect(errorOf(answer.body).message).toContain(
      "needed more disk space than a publication may use",
    );
    expect(await github.readBranch(repository, thread.workBranch)).toBeUndefined();
  });

  it("stops a Git command that takes longer than allowed, such as a fetch from a server that does not answer", async () => {
    await restartWithLimits({ wallTimeInMilliseconds: 1_000 });
    const thread = await startPublishingThread();
    await commit(thread.clone, "agent.txt");
    const held = github.holdNextGitRequest("fetch");

    const answer = await publish(
      thread,
      await bundleOf(thread.clone, [`${thread.baseCommit}..${thread.workBranch}`]),
    );
    held.release();

    expect(errorOf(answer.body).message).toBe(
      "Fetching the base branch's history took longer than a publication may take (1 seconds), so the branch cannot be published.",
    );
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

/** The agent's work branch since the base, as the supervisor bundles it. */
function bundleSinceBase(thread: PublishingThread): Promise<Buffer> {
  return bundleOf(thread.clone, [`${thread.baseCommit}..${thread.workBranch}`]);
}

/** The agent fetches its branch as someone else left it in the repository, with its read token, and works on from there. */
async function takeBranchFromRepository(thread: PublishingThread): Promise<void> {
  await runGit(
    ["fetch", "--quiet", repository.directory, `${thread.workBranch}:refs/remotes/published`],
    thread.clone,
  );
  await runGit(["reset", "--quiet", "--hard", "refs/remotes/published"], thread.clone);
}

async function commitIsAncestor(ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", ancestor, descendant], repository.directory);
    return true;
  } catch {
    return false;
  }
}

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
