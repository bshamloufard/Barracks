import { escapeIdentifier, type Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CredentialKeyring,
  UnreadableCredentialError,
} from "../model-access/credential-keyring.js";
import {
  createTestPool,
  describeWithTestDatabase,
  TestSchemas,
} from "../test-support/test-database.js";
import { PostgresUserStore } from "../users/postgres-user-store.js";
import type { PlanSignIn } from "./chatgpt-plan-store.js";
import { PostgresChatGptPlanStore } from "./postgres-chatgpt-plan-store.js";

const ada = "11111111-1111-4111-8111-111111111111";
const grace = "22222222-2222-4222-8222-222222222222";

function signInFor(accessToken: string, refreshToken: string): PlanSignIn {
  const now = new Date("2026-11-25T10:00:00.000Z");
  return {
    clientId: "oaiapp-test",
    tokens: { accessToken, refreshToken },
    accessExpiresAt: new Date(now.getTime() + 3_600_000),
    earliestRenewalAt: undefined,
    accountSubject: "chatgpt-account",
    accountEmail: undefined,
    connectedAt: now,
    renewedAt: now,
  };
}

describeWithTestDatabase("the Postgres ChatGPT plan store", () => {
  let pool: Pool;
  let schemas: TestSchemas;
  const keyring = new CredentialKeyring(Buffer.alloc(32, 3));

  beforeAll(() => {
    pool = createTestPool(3);
    schemas = new TestSchemas(pool);
  });

  afterAll(async () => {
    await schemas.dropAll();
    await pool.end();
  });

  async function createStore(): Promise<{ store: PostgresChatGptPlanStore; schema: string }> {
    const schema = await schemas.createMigrated();
    const users = new PostgresUserStore(pool, schema);
    for (const userId of [ada, grace]) {
      await users.recordUser(userId, undefined);
    }
    const store = new PostgresChatGptPlanStore(pool, keyring, schema);
    for (const userId of [ada, grace]) {
      await store.findOrCreatePlan(userId, `urn:uuid:${userId}`);
    }
    return { store, schema };
  }

  it("keeps no token readable in the database", async () => {
    const { store, schema } = await createStore();
    await store.connect(ada, signInFor("access-token-of-ada-0001", "refresh-token-of-ada-0001"));

    const dump = await pool.query(
      `select row_to_json(sign_ins)::text as row from ${escapeIdentifier(schema)}.chatgpt_plan_sign_ins sign_ins`,
    );

    const rows = dump.rows.map((row: { row: string }) => row.row).join("\n");
    expect(rows).not.toContain("access-token-of-ada");
    expect(rows).not.toContain("refresh-token-of-ada");
    expect(rows).not.toContain(Buffer.from("refresh-token-of-ada").toString("hex"));
    expect((await store.readSignIn(ada))?.tokens.refreshToken).toBe("refresh-token-of-ada-0001");
  });

  it("does not open one user's sealed tokens moved to another user's row", async () => {
    const { store, schema } = await createStore();
    await store.connect(ada, signInFor("access-token-of-ada-0002", "refresh-token-of-ada-0002"));
    const table = `${escapeIdentifier(schema)}.chatgpt_plan_sign_ins`;

    await pool.query(
      `insert into ${table} select $2, client_id, key_fingerprint, nonce, ciphertext,
          access_expires_at, earliest_renewal_at, account_subject, account_email,
          connected_at, renewed_at
        from ${table} where user_id = $1`,
      [ada, grace],
    );

    await expect(store.readSignIn(grace)).rejects.toBeInstanceOf(UnreadableCredentialError);
  });
});
