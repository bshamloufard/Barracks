import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { escapeIdentifier, type Pool, type PoolClient } from "pg";
import type { Logger } from "../logger.js";

/**
 * Applies the SQL files in `apps/control-plane/migrations` in name order,
 * each once, each in its own transaction, recording them in the schema's
 * `schema_migrations` table. The path resolves the same from `src` and
 * `dist`, which sit at the same depth.
 */
export const migrationsDirectory = new URL("../../migrations/", import.meta.url);

/** Four digits, an underscore, and a lower-case description, such as `0001_create_thread_event_log.sql`. */
const migrationFileNamePattern = /^\d{4}_[a-z0-9_]+\.sql$/;

type Migration = { name: string; sql: string; checksum: string };

type AppliedMigration = { name: string; checksum: string };

export type MigrationOptions = {
  pool: Pool;
  /** Every table the migrations create goes in this schema; tests give each run its own. */
  schema: string;
  logger: Logger;
  directory?: URL;
};

/**
 * Brings the schema up to date and returns the names of the migrations it
 * applied. Instances starting together take turns under an advisory lock,
 * so each migration runs once. A migration edited after it was applied, or
 * an applied one this build does not have, stops it before anything changes.
 */
export async function applyPendingMigrations(options: MigrationOptions): Promise<string[]> {
  const migrations = await readMigrations(options.directory ?? migrationsDirectory);
  const client = await options.pool.connect();
  let isConnectionReusable = true;
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [lockNameFor(options)]);
    try {
      return await applyWhileLocked(client, migrations, options);
    } finally {
      await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [
        lockNameFor(options),
      ]);
    }
  } catch (error) {
    isConnectionReusable = false;
    throw error;
  } finally {
    // A connection that failed is closed rather than reused, which ends its
    // session and with it any lock or transaction it still held.
    client.release(!isConnectionReusable);
  }
}

async function applyWhileLocked(
  client: PoolClient,
  migrations: Migration[],
  options: MigrationOptions,
): Promise<string[]> {
  const schema = escapeIdentifier(options.schema);
  await createMigrationTable(client, schema);
  const applied = await client.query<AppliedMigration>(
    `select name, checksum from ${schema}.schema_migrations order by name`,
  );
  const pending = findPendingMigrations(migrations, applied.rows);
  for (const migration of pending) {
    await applyMigration(client, schema, migration);
    options.logger.info({ migration: migration.name }, "Applied a database migration");
  }
  options.logger.info(
    { appliedMigrationCount: pending.length, schema: options.schema },
    "The database schema is up to date",
  );
  return pending.map((migration) => migration.name);
}

/** Row level security is enabled here too; see the first migration for why. */
async function createMigrationTable(client: PoolClient, schema: string): Promise<void> {
  await client.query(`create schema if not exists ${schema}`);
  await client.query(
    `create table if not exists ${schema}.schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`,
  );
  await client.query(`alter table ${schema}.schema_migrations enable row level security`);
}

/**
 * The applied migrations must be exactly this build's first migrations,
 * unchanged. Changing an applied migration would leave databases migrated
 * before and after the change different with no record of it, so a change
 * goes in a new migration instead.
 */
function findPendingMigrations(
  migrations: Migration[],
  appliedMigrations: AppliedMigration[],
): Migration[] {
  for (const [index, applied] of appliedMigrations.entries()) {
    const migration = migrations[index];
    if (migration?.name !== applied.name) {
      throw new Error(
        `The database has migration ${applied.name} applied, which this build does not have in that place (it has ${migration?.name ?? "nothing"}). It was probably migrated by a different version of the control plane.`,
      );
    }
    if (migration.checksum !== applied.checksum) {
      throw new Error(
        `Migration ${applied.name} has changed since it was applied. Restore it, and put the change in a new migration.`,
      );
    }
  }
  return migrations.slice(appliedMigrations.length);
}

/** Unqualified names in a migration refer to the target schema. */
async function applyMigration(
  client: PoolClient,
  schema: string,
  migration: Migration,
): Promise<void> {
  await client.query("begin");
  try {
    await client.query(`set local search_path to ${schema}`);
    await client.query(migration.sql);
    await client.query(`insert into ${schema}.schema_migrations (name, checksum) values ($1, $2)`, [
      migration.name,
      migration.checksum,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw new Error(`Could not apply migration ${migration.name}`, { cause: error });
  }
}

async function readMigrations(directory: URL): Promise<Migration[]> {
  const fileNames = (await readdir(directory)).filter((fileName) => fileName.endsWith(".sql"));
  const misnamed = fileNames.filter((fileName) => !migrationFileNamePattern.test(fileName));
  if (misnamed.length > 0) {
    throw new Error(
      `Migration files must be named like 0001_description.sql; found ${misnamed.join(", ")}`,
    );
  }
  const migrations = [];
  for (const name of fileNames.sort()) {
    const sql = await readFile(new URL(name, directory), "utf8");
    migrations.push({ name, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  return migrations;
}

/** One lock per schema, so test runs migrating their own schemas do not wait for each other. */
function lockNameFor(options: MigrationOptions): string {
  return `barrack migrations for schema ${options.schema}`;
}
