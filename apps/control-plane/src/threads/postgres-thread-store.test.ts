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

describeWithTestDatabase("the Postgres thread store", () => {
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
      store.create({
        threadId: "thread-a",
        ownerUserId: "never-signed-in",
        sandboxProvider: "fake",
        supervisorTokenDigest: Buffer.alloc(32, 1),
      }),
    ).rejects.toThrow(/foreign key/);
  });

  it("shows a thread created before sign-in existed, which has no owner, to nobody", async () => {
    const schema = await schemas.createMigrated();
    const store = new PostgresThreadStore(pool, schema);
    await new PostgresUserStore(pool, schema).recordUser("user-a");
    await pool.query(
      `insert into "${schema}".threads
        (thread_id, created_at, sandbox_provider, supervisor_token_digest, sandbox_state)
        values ('from-before-sign-in', now(), 'fake', $1, 'creating')`,
      [Buffer.alloc(32, 1)],
    );

    expect((await store.find("from-before-sign-in"))?.ownerUserId).toBeUndefined();
    expect(await store.findOwnedBy("user-a", "from-before-sign-in")).toBeUndefined();
    expect(await store.listNewestFirstOwnedBy("user-a", 10)).toEqual([]);
  });
});
