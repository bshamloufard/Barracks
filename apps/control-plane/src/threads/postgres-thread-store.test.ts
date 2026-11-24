import type { Pool } from "pg";
import { afterAll, beforeAll } from "vitest";
import {
  createTestPool,
  describeWithTestDatabase,
  TestSchemas,
} from "../test-support/test-database.js";
import { describeThreadStoreContract } from "../test-support/thread-store-contract.js";
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

  describeThreadStoreContract(
    "PostgresThreadStore",
    async () => new PostgresThreadStore(pool, await schemas.createMigrated()),
  );
});
