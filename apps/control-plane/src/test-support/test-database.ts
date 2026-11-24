import { randomBytes } from "node:crypto";
import { escapeIdentifier, type Pool } from "pg";
import { pino } from "pino";
import { describe } from "vitest";
import { readDatabaseConfiguration } from "../database/database-configuration.js";
import { createDatabasePool } from "../database/database-pool.js";
import { applyPendingMigrations } from "../database/migration-runner.js";

/**
 * Tests that need a real Postgres run only when `BARRACK_TEST_DATABASE_URL`
 * names one (`pnpm test-database:start` starts a throwaway one). TLS is off
 * unless `BARRACK_TEST_DATABASE_TLS` says otherwise, since a test database
 * is normally local. Every test works in schemas of its own, which are
 * dropped afterwards, so test files can run at once against one database.
 */
const {
  BARRACK_TEST_DATABASE_URL: testDatabaseUrl,
  BARRACK_TEST_DATABASE_TLS: testDatabaseTlsMode,
  BARRACK_TEST_DATABASE_CA_CERTIFICATE: testDatabaseCertificateAuthorities,
} = process.env;

export const silentLogger = pino({ level: "silent" });

/** A `describe` whose tests are skipped, with the reason in their name, when there is no test database. */
export function describeWithTestDatabase(name: string, defineTests: () => void): void {
  if (testDatabaseUrl === undefined || testDatabaseUrl === "") {
    describe.skip(
      `${name} (skipped: set BARRACK_TEST_DATABASE_URL to a Postgres database to run these)`,
      defineTests,
    );
    return;
  }
  describe(name, defineTests);
}

/** A pool on the test database, standing in for one control plane instance. */
export function createTestPool(poolSize = 5): Pool {
  const result = readDatabaseConfiguration({
    BARRACK_DATABASE_URL: testDatabaseUrl,
    BARRACK_DATABASE_TLS: testDatabaseTlsMode ?? "disable",
    BARRACK_DATABASE_CA_CERTIFICATE: testDatabaseCertificateAuthorities,
    BARRACK_DATABASE_POOL_SIZE: String(poolSize),
  });
  if (!result.ok || result.configuration === undefined) {
    throw new Error(
      `The test database settings are invalid: ${result.ok ? "no URL" : result.problems.join("; ")}`,
    );
  }
  return createDatabasePool(result.configuration, silentLogger);
}

/** Hands out uniquely named schemas and drops every one of them at the end. */
export class TestSchemas {
  readonly #pool: Pool;
  readonly #names: string[] = [];

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** A name no other test uses; the schema itself is left for a migration run to create. */
  reserveName(): string {
    const name = `barrack_test_${randomBytes(8).toString("hex")}`;
    this.#names.push(name);
    return name;
  }

  /** A new schema holding the control plane's tables, as the real migrations create them. */
  async createMigrated(): Promise<string> {
    const name = this.reserveName();
    await applyPendingMigrations({ pool: this.#pool, schema: name, logger: silentLogger });
    return name;
  }

  async dropAll(): Promise<void> {
    for (const name of this.#names.splice(0)) {
      await this.#pool.query(`drop schema if exists ${escapeIdentifier(name)} cascade`);
    }
  }
}
