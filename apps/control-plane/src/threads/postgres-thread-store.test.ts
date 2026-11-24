import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createTestPool,
  describeWithTestDatabase,
  TestSchemas,
} from "../test-support/test-database.js";
import {
  contractOwnerUserIds,
  describeThreadStoreContract,
} from "../test-support/thread-store-contract.js";
import { PostgresUserStore } from "../users/postgres-user-store.js";
import { PostgresThreadStore } from "./postgres-thread-store.js";
import type { SandboxAdmission } from "./thread-store.js";

const admission: SandboxAdmission = { maximumPerUser: 3, maximumInInstallation: undefined };

describeWithTestDatabase("the Postgres thread store", () => {
  let pool: Pool;
  let otherPool: Pool;
  let schemas: TestSchemas;

  beforeAll(() => {
    pool = createTestPool();
    otherPool = createTestPool();
    schemas = new TestSchemas(pool);
  });

  afterAll(async () => {
    await schemas.dropAll();
    await pool.end();
    await otherPool.end();
  });

  describeThreadStoreContract("PostgresThreadStore", async () => {
    const schema = await schemas.createMigrated();
    const userStore = new PostgresUserStore(pool, schema);
    for (const userId of contractOwnerUserIds) {
      await userStore.recordUser(userId);
    }
    return new PostgresThreadStore(pool, schema);
  });

  it("refuses a thread whose owner is not a recorded user", async () => {
    const store = new PostgresThreadStore(pool, await schemas.createMigrated());

    await expect(
      store.create(
        {
          threadId: "thread-a",
          ownerUserId: "never-signed-in",
          sandboxProvider: "fake",
          supervisorTokenDigest: Buffer.alloc(32, 1),
        },
        { at: new Date(), leaseExpiresAt: new Date(), admission },
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("lets exactly one of two control planes, each with its own connections, stop the same sandbox", async () => {
    const schema = await schemas.createMigrated();
    await new PostgresUserStore(pool, schema).recordUser("user-a");
    const firstInstance = new PostgresThreadStore(pool, schema);
    const secondInstance = new PostgresThreadStore(otherPool, schema);
    const created = await firstInstance.create(
      {
        threadId: "thread-a",
        ownerUserId: "user-a",
        sandboxProvider: "fake",
        supervisorTokenDigest: Buffer.alloc(32, 1),
      },
      { at: new Date(), leaseExpiresAt: new Date(), admission },
    );
    const running =
      created.kind === "changed" &&
      (await firstInstance.transition({
        threadId: "thread-a",
        fromVersion: created.thread.version,
        to: { state: "running", sandboxId: "sandbox-1", problem: undefined },
        at: new Date(),
      }));
    if (running === false || running.kind !== "changed") {
      throw new Error("The thread did not reach running");
    }
    const stopThrough = (store: PostgresThreadStore) =>
      store.transition({
        threadId: "thread-a",
        fromVersion: running.thread.version,
        to: { state: "stopping", sandboxId: "sandbox-1", leaseExpiresAt: new Date() },
        at: new Date(),
      });

    const outcomes = await Promise.all([stopThrough(firstInstance), stopThrough(secondInstance)]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["changed", "conflict"]);
  });

  it("shows a thread created before sign-in existed, which has no owner, to nobody", async () => {
    const schema = await schemas.createMigrated();
    const store = new PostgresThreadStore(pool, schema);
    await new PostgresUserStore(pool, schema).recordUser("user-a");
    await pool.query(
      `insert into "${schema}".threads
        (thread_id, created_at, last_activity_at, sandbox_provider, supervisor_token_digest,
          sandbox_state, sandbox_id)
        values ('from-before-sign-in', now(), now(), 'fake', $1, 'running', 'sandbox-1')`,
      [Buffer.alloc(32, 1)],
    );

    expect((await store.find("from-before-sign-in"))?.ownerUserId).toBeUndefined();
    expect(await store.findOwnedBy("user-a", "from-before-sign-in")).toBeUndefined();
    expect(await store.listMostRecentlyActiveOwnedBy("user-a", 10)).toEqual([]);
  });
});
