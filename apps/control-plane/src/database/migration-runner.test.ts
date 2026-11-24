import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { applyPendingMigrations } from "./migration-runner.js";

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
      { name: "schema_migrations", has_row_security: true },
      { name: "thread_events", has_row_security: true },
      { name: "thread_sequence_counters", has_row_security: true },
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
});
