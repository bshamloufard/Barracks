import { randomBytes } from "node:crypto";
import pg from "pg";

/**
 * The Postgres server the control plane's database tests use, when one is
 * named (`pnpm test-database:start` starts one). Tests that need history to
 * survive a control plane restart run only then.
 */
const { BARRACK_TEST_DATABASE_URL: configuredTestDatabaseUrl } = process.env;
export const testDatabaseUrl = configuredTestDatabaseUrl || undefined;

export type ThrowawayDatabase = {
  /** Connects as the test database's user to a database of its own. */
  url: string;
  drop(): Promise<void>;
};

/**
 * A new, empty database on the test server, so a control plane started on
 * it migrates its own schema and shares nothing with other tests, then
 * dropped with whatever connections remain.
 */
export async function createThrowawayDatabase(serverUrl: string): Promise<ThrowawayDatabase> {
  const databaseName = `barrack_end_to_end_${randomBytes(6).toString("hex")}`;
  await runOnServer(serverUrl, `create database ${databaseName}`);
  const url = new URL(serverUrl);
  url.pathname = `/${databaseName}`;
  return {
    url: url.toString(),
    drop: () => runOnServer(serverUrl, `drop database if exists ${databaseName} with (force)`),
  };
}

async function runOnServer(serverUrl: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}
