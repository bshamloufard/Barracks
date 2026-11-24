import { escapeIdentifier, type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  credentialContractOwnerUserIds,
  describeModelCredentialStoreContract,
} from "../test-support/model-credential-store-contract.js";
import {
  createTestPool,
  describeWithTestDatabase,
  TestSchemas,
} from "../test-support/test-database.js";
import { PostgresUserStore } from "../users/postgres-user-store.js";
import { CredentialKeyring } from "./credential-keyring.js";
import { PostgresModelCredentialStore } from "./postgres-model-credential-store.js";

describeWithTestDatabase("the Postgres model credential store", () => {
  let pool: Pool;
  let schemas: TestSchemas;

  beforeAll(() => {
    pool = createTestPool(5);
    schemas = new TestSchemas(pool);
  });

  afterAll(async () => {
    await schemas.dropAll();
    await pool.end();
  });

  async function createSchemaWithOwners(): Promise<string> {
    const schema = await schemas.createMigrated();
    const users = new PostgresUserStore(pool, schema);
    for (const userId of credentialContractOwnerUserIds) {
      await users.recordUser(userId, undefined);
    }
    return schema;
  }

  describeModelCredentialStoreContract("PostgresModelCredentialStore", async () => {
    const schema = await createSchemaWithOwners();
    const table = `${escapeIdentifier(schema)}.model_credentials`;
    return {
      storeWith: (keyring) => new PostgresModelCredentialStore(pool, keyring, schema),
      tamperWith: async ({ ownerUserId, providerId }) => {
        await pool.query(
          `update ${table} set ciphertext = overlay(ciphertext placing
              decode(lpad(to_hex(get_byte(ciphertext, 0) # 1), 2, '0'), 'hex') from 1 for 1)
            where user_id = $1 and provider_id = $2`,
          [ownerUserId, providerId],
        );
      },
      copySealed: async (from, to) => {
        await pool.query(
          `update ${table} as target set
              key_fingerprint = source.key_fingerprint,
              nonce = source.nonce,
              ciphertext = source.ciphertext
            from ${table} as source
            where source.user_id = $1 and source.provider_id = $2
              and target.user_id = $3 and target.provider_id = $4`,
          [from.ownerUserId, from.providerId, to.ownerUserId, to.providerId],
        );
      },
    };
  });

  it("stores no key, nor any part of one beyond its last four characters, readable in the database", async () => {
    const schema = await createSchemaWithOwners();
    const store = new PostgresModelCredentialStore(
      pool,
      new CredentialKeyring(Buffer.alloc(32, 7)),
      schema,
    );
    const secret = "sk-test-never-readable-0123456789";
    await store.save({
      ownerUserId: "user-a",
      providerId: "openai",
      secret,
      settings: {},
      addedAt: new Date(),
    });

    const rows = await pool.query(`select * from ${escapeIdentifier(schema)}.model_credentials`);
    const stored = JSON.stringify(rows.rows, (_key, value) =>
      value?.type === "Buffer" ? Buffer.from(value.data).toString("latin1") : value,
    );
    expect(stored).not.toContain(secret.slice(0, 12));
    expect(stored).toContain('"secret_ending":"6789"');
  });

  it("removes a user's keys with the user", async () => {
    const schema = await createSchemaWithOwners();
    const store = new PostgresModelCredentialStore(
      pool,
      new CredentialKeyring(Buffer.alloc(32, 7)),
      schema,
    );
    await store.save({
      ownerUserId: "user-b",
      providerId: "openai",
      secret: "key-of-user-b",
      settings: {},
      addedAt: new Date(),
    });

    await pool.query(`delete from ${escapeIdentifier(schema)}.users where user_id = 'user-b'`);

    expect(await store.list("user-b")).toEqual([]);
  });
});
