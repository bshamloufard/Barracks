import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { escapeIdentifier, type Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createTestPool,
  describeWithTestDatabase,
  silentLogger,
  TestSchemas,
} from "../test-support/test-database.js";
import { PostgresThreadEventLog } from "../thread-event-log/postgres-thread-event-log.js";
import { PostgresThreadStore } from "../threads/postgres-thread-store.js";
import { applyPendingMigrations, migrationsDirectory } from "./migration-runner.js";

describeWithTestDatabase("the migration runner", () => {
  let pool: Pool;
  let schemas: TestSchemas;
  let directoryPath: string;

  beforeAll(() => {
    pool = createTestPool();
    schemas = new TestSchemas(pool);
  });

  afterAll(async () => {
    await schemas.dropAll();
    await pool.end();
  });

  beforeEach(async () => {
    directoryPath = await mkdtemp(join(tmpdir(), "barrack-migrations-"));
  });

  afterEach(async () => {
    await rm(directoryPath, { recursive: true });
  });

  async function writeMigration(name: string, sql: string): Promise<void> {
    await writeFile(join(directoryPath, name), sql);
  }

  function migrate(schema: string, migrationPool: Pool = pool): Promise<string[]> {
    return applyPendingMigrations({
      pool: migrationPool,
      schema,
      logger: silentLogger,
      directory: pathToFileURL(`${directoryPath}/`),
    });
  }

  async function countRows(schema: string, table: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      `select count(*)::integer as count from ${escapeIdentifier(schema)}.${escapeIdentifier(table)}`,
    );
    return result.rows[0]?.count ?? 0;
  }

  async function tableExists(schema: string, table: string): Promise<boolean> {
    const result = await pool.query("select to_regclass($1) is not null as exists", [
      `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`,
    ]);
    return result.rows[0]?.exists === true;
  }

  it("applies each migration once, in name order, into the given schema", async () => {
    const schema = schemas.reserveName();
    await writeMigration("0002_add_a_row.sql", "insert into counted (value) values (1);");
    await writeMigration("0001_create_a_table.sql", "create table counted (value integer);");

    const firstRun = await migrate(schema);
    const secondRun = await migrate(schema);

    expect(firstRun).toEqual(["0001_create_a_table.sql", "0002_add_a_row.sql"]);
    expect(secondRun).toEqual([]);
    expect(await countRows(schema, "counted")).toBe(1);
  });

  it("applies only the migrations added since it last ran", async () => {
    const schema = schemas.reserveName();
    await writeMigration("0001_create_a_table.sql", "create table counted (value integer);");
    await migrate(schema);
    await writeMigration("0002_add_a_row.sql", "insert into counted (value) values (1);");

    expect(await migrate(schema)).toEqual(["0002_add_a_row.sql"]);
  });

  it("applies each migration once when several control planes start at the same moment", async () => {
    const schema = schemas.reserveName();
    // The pause widens the window in which a second runner could slip in.
    await writeMigration(
      "0001_create_a_table.sql",
      "create table counted (value integer); select pg_sleep(0.2);",
    );
    await writeMigration("0002_add_a_row.sql", "insert into counted (value) values (1);");
    const pools = Array.from({ length: 4 }, () => createTestPool(1));

    try {
      const runs = await Promise.all(pools.map((runnerPool) => migrate(schema, runnerPool)));

      expect(runs.flat().toSorted()).toEqual(["0001_create_a_table.sql", "0002_add_a_row.sql"]);
      expect(runs.filter((applied) => applied.length > 0)).toHaveLength(1);
      expect(await countRows(schema, "counted")).toBe(1);
    } finally {
      await Promise.all(pools.map((runnerPool) => runnerPool.end()));
    }
  });

  it("refuses to run when a migration was edited after it was applied, and changes nothing", async () => {
    const schema = schemas.reserveName();
    await writeMigration("0001_create_a_table.sql", "create table counted (value integer);");
    await migrate(schema);
    await writeMigration("0001_create_a_table.sql", "create table counted (value bigint);");
    await writeMigration("0002_add_a_row.sql", "insert into counted (value) values (1);");

    await expect(migrate(schema)).rejects.toThrow(
      "Migration 0001_create_a_table.sql has changed since it was applied",
    );
    expect(await countRows(schema, "counted")).toBe(0);
  });

  it("refuses to run when the database has a migration this build does not", async () => {
    const schema = schemas.reserveName();
    await writeMigration("0001_create_a_table.sql", "create table counted (value integer);");
    await writeMigration("0002_add_a_row.sql", "insert into counted (value) values (1);");
    await migrate(schema);
    await rm(join(directoryPath, "0002_add_a_row.sql"));

    await expect(migrate(schema)).rejects.toThrow(
      "The database has migration 0002_add_a_row.sql applied",
    );
  });

  it("rolls a failing migration back entirely and records nothing for it", async () => {
    const schema = schemas.reserveName();
    await writeMigration("0001_create_a_table.sql", "create table counted (value integer);");
    await writeMigration(
      "0002_half_works.sql",
      "create table half (value integer); select * from no_such_table;",
    );

    await expect(migrate(schema)).rejects.toThrow("Could not apply migration 0002_half_works.sql");
    expect(await tableExists(schema, "half")).toBe(false);
    expect(await tableExists(schema, "counted")).toBe(true);
    expect(await countRows(schema, "schema_migrations")).toBe(1);
  });

  it("refuses a migration file named out of pattern", async () => {
    const schema = schemas.reserveName();
    await writeMigration("1_create_a_table.sql", "create table counted (value integer);");

    await expect(migrate(schema)).rejects.toThrow("found 1_create_a_table.sql");
  });
});

describeWithTestDatabase("the control plane's migrations", () => {
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

  it("turn on row level security, with no policies, for every table they create", async () => {
    const schema = await schemas.createMigrated();

    const tables = await pool.query<{ name: string; has_row_security: boolean }>(
      `select c.relname as name, c.relrowsecurity as has_row_security
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relkind = 'r' order by c.relname`,
      [schema],
    );
    const policies = await pool.query("select 1 from pg_policies where schemaname = $1", [schema]);

    expect(tables.rows).toEqual([
      { name: "github_connection_attempts", has_row_security: true },
      { name: "github_connections", has_row_security: true },
      { name: "schema_migrations", has_row_security: true },
      { name: "thread_events", has_row_security: true },
      { name: "thread_repositories", has_row_security: true },
      { name: "thread_sequence_counters", has_row_security: true },
      { name: "threads", has_row_security: true },
      { name: "users", has_row_security: true },
    ]);
    expect(policies.rows).toEqual([]);
  });

  it("refuse thread identifiers the protocol does not allow", async () => {
    const schema = await schemas.createMigrated();

    await expect(
      pool.query(
        `insert into ${escapeIdentifier(schema)}.thread_sequence_counters values ('../etc', 1)`,
      ),
    ).rejects.toThrow("violates check constraint");
  });

  it("refuse a running thread without a sandbox, a failed one without a reason, and one under way without a lease", async () => {
    const schema = await schemas.createMigrated();
    const insertThread = (state: string, lease: Date | null = null) =>
      pool.query(
        `insert into ${escapeIdentifier(schema)}.threads
          (thread_id, created_at, last_activity_at, sandbox_provider, supervisor_token_digest,
            sandbox_state, lease_expires_at)
          values ('thread-1', now(), now(), 'fake', $1, $2, $3)`,
        [Buffer.alloc(32), state, lease],
      );

    await expect(insertThread("ready")).rejects.toThrow("violates check constraint");
    await expect(insertThread("running")).rejects.toThrow("violates check constraint");
    await expect(insertThread("failed")).rejects.toThrow("violates check constraint");
    await expect(insertThread("creating")).rejects.toThrow("violates check constraint");
    await expect(insertThread("creating", new Date())).resolves.toBeDefined();
  });

  it("carry threads recorded before the sandbox lifecycle into it", async () => {
    const schema = schemas.reserveName();
    const earlierMigrationsPath = await mkdtemp(join(tmpdir(), "barrack-earlier-migrations-"));
    const migrationNames = (await readdir(migrationsDirectory)).sort();
    for (const name of migrationNames.filter((fileName) => fileName < "0030")) {
      const sql = await readFile(new URL(name, migrationsDirectory), "utf8");
      await writeFile(join(earlierMigrationsPath, name), sql);
    }
    await applyPendingMigrations({
      pool,
      schema,
      logger: silentLogger,
      directory: pathToFileURL(`${earlierMigrationsPath}/`),
    });
    await rm(earlierMigrationsPath, { recursive: true });
    const table = (name: string) => `${escapeIdentifier(schema)}.${name}`;
    await pool.query(`insert into ${table("users")} values ('user-a', now())`);
    await pool.query(
      `insert into ${table("threads")}
        (thread_id, owner_user_id, created_at, sandbox_provider, supervisor_token_digest,
          sandbox_state, sandbox_id)
        values ('was-ready', 'user-a', now(), 'fake', $1, 'ready', 'sandbox-1'),
          ('was-creating', 'user-a', now(), 'fake', $1, 'creating', null)`,
      [Buffer.alloc(32)],
    );
    await pool.query(
      `insert into ${table("thread_sequence_counters")} values ('was-ready', 2, null, 1)`,
    );
    await pool.query(
      `insert into ${table("thread_events")} (thread_id, sequence, recorded_at, event) values
        ('was-ready', 1, now(), '{"type":"user_message","messageId":"m-1","text":"Hi"}'),
        ('was-ready', 2, now(), '{"type":"user_message","messageId":"m-2","text":"Again"}')`,
    );

    await applyPendingMigrations({ pool, schema, logger: silentLogger });

    const store = new PostgresThreadStore(pool, schema);
    const log = new PostgresThreadEventLog(pool, schema);
    expect((await store.find("was-ready"))?.sandbox).toEqual({
      state: "running",
      sandboxId: "sandbox-1",
      problem: undefined,
    });
    expect((await store.find("was-creating"))?.sandbox).toMatchObject({ state: "creating" });
    expect(await log.readAgentWork("was-ready")).toEqual({
      hasOpenRun: false,
      hasUndeliveredUserMessage: true,
    });
  });
});
