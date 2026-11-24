import { FakeGithub, type FakeRepository } from "@barrack/fake-github";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryGithubConnectionStore } from "../github/in-memory-github-connection-store.js";
import { githubApiFor } from "../test-support/github-test-setup.js";
import { InMemoryThreadStore } from "../threads/in-memory-thread-store.js";
import { RepositoryCredentials } from "./repository-credentials.js";
import type { NewThreadRepository } from "./thread-repository-store.js";

/**
 * What a sandbox can obtain when its Git asks for credentials: a token
 * minted by the App for its own thread's repository only, that can only
 * read it, never another thread's, and not without limit.
 */

const logger = pino({ level: "silent" });
const owner = "owner-user";

let github: FakeGithub;
let firstRepository: FakeRepository;
let secondRepository: FakeRepository;
let installationId: number;
let threadStore: InMemoryThreadStore;
let connections: InMemoryGithubConnectionStore;
let now: Date;

function credentials(limits = { burst: 30, refillIntervalInMilliseconds: 2_000 }) {
  return new RepositoryCredentials({
    threadStore,
    repositories: threadStore.repositories,
    connections,
    api: githubApiFor(github),
    clock: () => now,
    logger,
    limits,
  });
}

function repositoryOf(repository: FakeRepository, threadId: string): NewThreadRepository {
  return {
    url: repository.cloneUrl,
    access: "github_app",
    baseBranch: "main",
    workBranch: `barrack/${threadId}`,
    github: {
      repositoryId: repository.id,
      installationId,
      fullName: repository.fullName,
      htmlUrl: repository.htmlUrl,
    },
  };
}

async function createThread(threadId: string, repository: NewThreadRepository | undefined) {
  await threadStore.create(
    {
      threadId,
      ownerUserId: owner,
      sandboxProvider: "fake",
      supervisorTokenDigest: Buffer.alloc(32),
      ...(repository === undefined ? {} : { repository }),
    },
    {
      at: now,
      leaseExpiresAt: now,
      admission: { maximumPerUser: 100, maximumInInstallation: undefined },
    },
  );
}

async function linkOwnerTo(repositories: FakeRepository[]) {
  await connections.save({
    userId: owner,
    githubUserId: 1,
    login: "octocat",
    name: undefined,
    connectedAt: now,
    repositories: repositories.map((repository) => ({
      id: repository.id,
      fullName: repository.fullName,
      installationId,
      defaultBranch: "main",
      cloneUrl: repository.cloneUrl,
      htmlUrl: repository.htmlUrl,
      isPrivate: true,
    })),
  });
}

beforeAll(async () => {
  github = await FakeGithub.start();
  firstRepository = await github.createRepository({
    owner: "octo",
    name: "first",
    isPrivate: true,
  });
  secondRepository = await github.createRepository({
    owner: "octo",
    name: "second",
    isPrivate: true,
  });
  installationId = github.installApp([firstRepository, secondRepository]);
}, 30_000);

afterAll(async () => {
  await github.close();
});

beforeEach(async () => {
  now = new Date();
  threadStore = new InMemoryThreadStore();
  connections = new InMemoryGithubConnectionStore();
  github.issuedTokens.length = 0;
  await createThread("thread-a", repositoryOf(firstRepository, "thread-a"));
  await createThread("thread-b", repositoryOf(secondRepository, "thread-b"));
  await linkOwnerTo([firstRepository, secondRepository]);
});

describe("repository credentials for a sandbox", () => {
  it("are a token for the thread's own repository that can only read it", async () => {
    const outcome = await credentials().issue("thread-a");

    expect(outcome).toMatchObject({ isGranted: true, username: "x-access-token" });
    const issued = github.issuedTokens.find(
      (token) => outcome.isGranted && token.token === outcome.password,
    );
    expect(issued).toMatchObject({
      repositoryIds: [firstRepository.id],
      permissions: { contents: "read", metadata: "read" },
    });
  });

  it("never reach another thread's repository, whichever thread asks", async () => {
    const service = credentials();
    const forA = await service.issue("thread-a");
    const forB = await service.issue("thread-b");

    const tokenFor = (outcome: typeof forA) =>
      github.issuedTokens.find((token) => outcome.isGranted && token.token === outcome.password);
    expect(tokenFor(forA)?.repositoryIds).toEqual([firstRepository.id]);
    expect(tokenFor(forB)?.repositoryIds).toEqual([secondRepository.id]);
  });

  it("reuse a token while it has long enough to live, so GitHub is asked once", async () => {
    const service = credentials();

    const answers = await Promise.all([service.issue("thread-a"), service.issue("thread-a")]);
    await service.issue("thread-a");

    expect(new Set(answers.map((answer) => answer.isGranted && answer.password)).size).toBe(1);
    expect(github.issuedTokens).toHaveLength(1);
  });

  it("are refused beyond the rate limit, and allowed again once it refills", async () => {
    const service = credentials({ burst: 2, refillIntervalInMilliseconds: 1_000 });

    const allowed = [await service.issue("thread-a"), await service.issue("thread-a")];
    const refused = await service.issue("thread-a");
    now = new Date(now.getTime() + 1_000);
    const afterRefill = await service.issue("thread-a");

    expect(allowed.every((answer) => answer.isGranted)).toBe(true);
    expect(refused).toMatchObject({
      isGranted: false,
      reason: expect.stringContaining("too often"),
    });
    expect(afterRefill.isGranted).toBe(true);
  });

  it("are refused for a public repository, and once the owner is no longer verified for it", async () => {
    await createThread("public-thread", {
      url: "https://example.com/octo/public.git",
      access: "none",
      baseBranch: undefined,
      workBranch: "barrack/public-thread",
      github: undefined,
    });
    const service = credentials();

    expect(await service.issue("public-thread")).toMatchObject({ isGranted: false });
    await linkOwnerTo([secondRepository]);
    expect(await service.issue("thread-a")).toMatchObject({ isGranted: false });
    await connections.remove(owner);
    expect(await service.issue("thread-b")).toMatchObject({ isGranted: false });
    expect(github.issuedTokens).toHaveLength(0);
  });

  it("are refused when GitHub no longer lets the App reach the repository", async () => {
    github.removeFromInstallation(installationId, firstRepository);
    try {
      expect(await credentials().issue("thread-a")).toMatchObject({ isGranted: false });
    } finally {
      github.addToInstallation(installationId, firstRepository);
    }
  });

  it("do not ask GitHub again for a minute once it refused, however often the sandbox asks", async () => {
    const service = credentials();
    github.removeFromInstallation(installationId, firstRepository);
    const mintsAskedFor = () =>
      github.requests.filter((request) => request.path.endsWith("/access_tokens")).length;
    try {
      await service.issue("thread-a");
      const afterFirstRefusal = mintsAskedFor();
      const meanwhile = await Promise.all(
        Array.from({ length: 10 }, () => service.issue("thread-a")),
      );
      const whileBackingOff = mintsAskedFor();
      github.addToInstallation(installationId, firstRepository);
      now = new Date(now.getTime() + 60_000);
      const afterBackoff = await service.issue("thread-a");

      expect(meanwhile.every((answer) => !answer.isGranted)).toBe(true);
      expect(afterFirstRefusal).toBeGreaterThan(0);
      expect(whileBackingOff).toBe(afterFirstRefusal);
      expect(afterBackoff.isGranted).toBe(true);
    } finally {
      github.addToInstallation(installationId, firstRepository);
    }
  });
});
