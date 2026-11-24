import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PostgresGithubConnectionStore } from "../github/postgres-github-connection-store.js";
import {
  createTestPool,
  describeWithTestDatabase,
  TestSchemas,
} from "../test-support/test-database.js";
import { PostgresThreadStore } from "../threads/postgres-thread-store.js";
import { PostgresUserStore } from "../users/postgres-user-store.js";
import { PostgresThreadRepositoryStore } from "./postgres-thread-repository-store.js";
import type { NewThreadRepository } from "./thread-repository-store.js";

/**
 * Threads' repositories and users' GitHub links in Postgres: a repository
 * is written with its thread and goes with it, a publication is recorded,
 * and a sign-in attempt is taken at most once.
 */

const owner = "owner-1";
const now = new Date("2026-11-24T09:00:00.000Z");
const admission = { maximumPerUser: 10, maximumInInstallation: undefined };

const repository: NewThreadRepository = {
  url: "https://github.com/octo/app.git",
  access: "github_app",
  baseBranch: "main",
  workBranch: "barrack/thread-1",
  github: {
    repositoryId: 12_345_678_901,
    installationId: 42,
    fullName: "octo/app",
    htmlUrl: "https://github.com/octo/app",
  },
};

describeWithTestDatabase("the Postgres repository and GitHub stores", () => {
  let pool: Pool;
  let schemas: TestSchemas;

  beforeAll(() => {
    pool = createTestPool();
    schemas = new TestSchemas(pool);
  });

  afterAll(async () => {
    await schemas.dropAll();
    await pool.end();
  });

  async function stores() {
    const schema = await schemas.createMigrated();
    await new PostgresUserStore(pool, schema).recordUser(owner);
    return {
      threads: new PostgresThreadStore(pool, schema),
      repositories: new PostgresThreadRepositoryStore(pool, schema),
      connections: new PostgresGithubConnectionStore(pool, schema),
    };
  }

  async function createThread(
    threads: PostgresThreadStore,
    threadId: string,
    withRepository: boolean,
  ) {
    const outcome = await threads.create(
      {
        threadId,
        ownerUserId: owner,
        sandboxProvider: "fake",
        supervisorTokenDigest: Buffer.alloc(32),
        ...(withRepository
          ? { repository: { ...repository, workBranch: `barrack/${threadId}` } }
          : {}),
      },
      { at: now, leaseExpiresAt: now, admission },
    );
    if (outcome.kind !== "changed") {
      throw new Error("The thread was not created");
    }
    return outcome.thread;
  }

  it("writes a thread's repository with the thread, records its publication, and removes it with the thread", async () => {
    const { threads, repositories } = await stores();
    await createThread(threads, "thread-1", true);
    await createThread(threads, "thread-2", false);

    await repositories.recordPublication("thread-1", {
      lastPublishedCommit: "0123456789abcdef0123456789abcdef01234567",
      pullRequest: { number: 3, url: "https://github.com/octo/app/pull/3" },
    });

    expect(await repositories.find("thread-1")).toEqual({
      ...repository,
      threadId: "thread-1",
      lastPublishedCommit: "0123456789abcdef0123456789abcdef01234567",
      pullRequest: { number: 3, url: "https://github.com/octo/app/pull/3" },
    });
    expect([...(await repositories.findMany(["thread-1", "thread-2"])).keys()]).toEqual([
      "thread-1",
    ]);

    const created = await threads.find("thread-1");
    const failed = await threads.transition({
      threadId: "thread-1",
      fromVersion: created?.version ?? 0,
      to: { state: "failed", sandboxId: undefined, reason: "Gone" },
      at: now,
    });
    const deleting = await threads.transition({
      threadId: "thread-1",
      fromVersion: failed.kind === "changed" ? failed.thread.version : 0,
      to: { state: "deleting", sandboxId: undefined, leaseExpiresAt: now },
      at: now,
    });
    const isRemoved = await threads.remove(
      "thread-1",
      deleting.kind === "changed" ? deleting.thread.version : 0,
    );
    expect(isRemoved).toBe(true);
    expect(await repositories.find("thread-1")).toBeUndefined();
  });

  it("keeps a recorded pull request when a later publication records none", async () => {
    const { threads, repositories } = await stores();
    await createThread(threads, "thread-1", true);
    const pullRequest = { number: 3, url: "https://github.com/octo/app/pull/3" };
    await repositories.recordPublication("thread-1", {
      lastPublishedCommit: "0123456789abcdef0123456789abcdef01234567",
      pullRequest,
    });

    await repositories.recordPublication("thread-1", {
      lastPublishedCommit: "89abcdef0123456789abcdef0123456789abcdef",
      pullRequest: undefined,
    });

    expect(await repositories.find("thread-1")).toMatchObject({
      lastPublishedCommit: "89abcdef0123456789abcdef0123456789abcdef",
      pullRequest,
    });
  });

  it("refuses a repository that says it is reached through the App without saying which", async () => {
    const { threads } = await stores();

    await expect(
      threads.create(
        {
          threadId: "thread-3",
          ownerUserId: owner,
          sandboxProvider: "fake",
          supervisorTokenDigest: Buffer.alloc(32),
          repository: { ...repository, github: undefined },
        },
        { at: now, leaseExpiresAt: now, admission },
      ),
    ).rejects.toThrow();
    expect(await threads.find("thread-3")).toBeUndefined();
  });

  it("takes a sign-in attempt once, keeps one per user, and keeps a link until it is forgotten", async () => {
    const { connections } = await stores();
    const attempt = {
      stateDigest: Buffer.alloc(32, 1),
      userId: owner,
      codeVerifier: "verifier",
      expiresAt: new Date(Date.now() + 60_000),
    };
    await connections.saveAttempt(attempt);
    await connections.saveAttempt({ ...attempt, stateDigest: Buffer.alloc(32, 2) });

    expect(await connections.takeAttempt(Buffer.alloc(32, 1))).toBeUndefined();
    expect(await connections.takeAttempt(Buffer.alloc(32, 2))).toMatchObject({ userId: owner });
    expect(await connections.takeAttempt(Buffer.alloc(32, 2))).toBeUndefined();

    const link = {
      userId: owner,
      githubUserId: 7,
      login: "octocat",
      name: "Octo Cat",
      connectedAt: now,
      repositories: [
        {
          id: 12_345_678_901,
          fullName: "octo/app",
          installationId: 42,
          defaultBranch: "main",
          cloneUrl: "https://github.com/octo/app.git",
          htmlUrl: "https://github.com/octo/app",
          isPrivate: true,
        },
      ],
    };
    await connections.save(link);
    await connections.save({ ...link, login: "octocat-renamed" });
    expect(await connections.find(owner)).toEqual({ ...link, login: "octocat-renamed" });
    await connections.remove(owner);
    expect(await connections.find(owner)).toBeUndefined();
  });
});
