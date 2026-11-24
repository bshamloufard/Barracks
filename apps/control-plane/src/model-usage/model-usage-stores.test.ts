import type { Pool } from "pg";
import { afterAll, beforeAll } from "vitest";
import { InMemoryModelProxyTokenStore } from "../model-proxy/in-memory-model-proxy-token-store.js";
import { InMemoryModelSwitchAllowanceStore } from "../model-proxy/in-memory-model-switch-allowance-store.js";
import { PostgresModelProxyTokenStore } from "../model-proxy/postgres-model-proxy-token-store.js";
import { PostgresModelSwitchAllowanceStore } from "../model-proxy/postgres-model-switch-allowance-store.js";
import {
  contractOwnerUserIds,
  contractThreadIds,
  describeModelProxyTokenStoreContract,
  describeModelSwitchAllowanceStoreContract,
  describeModelUsageStoreContract,
} from "../test-support/model-proxy-store-contracts.js";
import { recordTestThread } from "../test-support/record-test-thread.js";
import {
  createTestPool,
  describeWithTestDatabase,
  TestSchemas,
} from "../test-support/test-database.js";
import { PostgresThreadStore } from "../threads/postgres-thread-store.js";
import { PostgresUserStore } from "../users/postgres-user-store.js";
import { InMemoryModelUsageStore } from "./in-memory-model-usage-store.js";
import { PostgresModelUsageStore } from "./postgres-model-usage-store.js";

describeModelProxyTokenStoreContract("InMemoryModelProxyTokenStore", async () => {
  const store = new InMemoryModelProxyTokenStore();
  return [store, store];
});

describeModelSwitchAllowanceStoreContract("InMemoryModelSwitchAllowanceStore", async () => {
  const store = new InMemoryModelSwitchAllowanceStore();
  return [store, store];
});

describeModelUsageStoreContract("InMemoryModelUsageStore", async () => {
  const store = new InMemoryModelUsageStore();
  return [store, store];
});

/** Two pools on one database stand in for two control plane instances during a redeploy. */
describeWithTestDatabase("the Postgres model proxy and usage stores", () => {
  let firstInstance: Pool;
  let secondInstance: Pool;
  let schemas: TestSchemas;

  beforeAll(() => {
    firstInstance = createTestPool(10);
    secondInstance = createTestPool(10);
    schemas = new TestSchemas(firstInstance);
  });

  afterAll(async () => {
    await schemas.dropAll();
    await firstInstance.end();
    await secondInstance.end();
  });

  async function createSchemaWithThreads(): Promise<string> {
    const schema = await schemas.createMigrated();
    const users = new PostgresUserStore(firstInstance, schema);
    for (const userId of contractOwnerUserIds) {
      await users.recordUser(userId, undefined);
    }
    const threads = new PostgresThreadStore(firstInstance, schema);
    for (const [index, threadId] of contractThreadIds.entries()) {
      await recordTestThread(threads, { threadId, ownerUserId: contractOwnerUserIds[index] ?? "" });
    }
    return schema;
  }

  describeModelProxyTokenStoreContract("PostgresModelProxyTokenStore", async () => {
    const schema = await createSchemaWithThreads();
    return [
      new PostgresModelProxyTokenStore(firstInstance, schema),
      new PostgresModelProxyTokenStore(secondInstance, schema),
    ];
  });

  describeModelSwitchAllowanceStoreContract("PostgresModelSwitchAllowanceStore", async () => {
    const schema = await createSchemaWithThreads();
    return [
      new PostgresModelSwitchAllowanceStore(firstInstance, schema),
      new PostgresModelSwitchAllowanceStore(secondInstance, schema),
    ];
  });

  describeModelUsageStoreContract("PostgresModelUsageStore", async () => {
    const schema = await createSchemaWithThreads();
    return [
      new PostgresModelUsageStore(firstInstance, schema),
      new PostgresModelUsageStore(secondInstance, schema),
    ];
  });
});
