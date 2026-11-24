import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createTestPool,
  describeWithTestDatabase,
  TestSchemas,
} from "../test-support/test-database.js";
import { describeUserStoreContract } from "../test-support/user-store-contract.js";
import { PostgresUserStore } from "./postgres-user-store.js";

describeWithTestDatabase("the Postgres user store", () => {
  let pool: Pool;
  let schemas: TestSchemas;

  beforeAll(() => {
    pool = createTestPool(10);
    schemas = new TestSchemas(pool);
  });

  afterAll(async () => {
    await schemas.dropAll();
    await pool.end();
  });

  describeUserStoreContract(
    "PostgresUserStore",
    async () => new PostgresUserStore(pool, await schemas.createMigrated()),
  );

  it("keeps one row for a user recorded by many connections at once", async () => {
    const schema = await schemas.createMigrated();
    const store = new PostgresUserStore(pool, schema);

    await Promise.all(Array.from({ length: 20 }, () => store.recordUser("user-a")));

    const rows = await pool.query(`select user_id from "${schema}".users`);
    expect(rows.rows).toEqual([{ user_id: "user-a" }]);
  });
});
