import { locationOf, readDatabaseConfiguration } from "./database/database-configuration.js";
import { createDatabasePool } from "./database/database-pool.js";
import { applyPendingMigrations } from "./database/migration-runner.js";
import { createLogger } from "./logger.js";
import { databaseSchema } from "./thread-event-log/postgres-thread-event-log.js";

/**
 * Applies pending migrations and exits, for migrating a database without
 * starting the control plane, which also migrates whenever it starts. Reads
 * the same database variables as the control plane.
 */
async function migrate(): Promise<void> {
  const configurationResult = readDatabaseConfiguration(process.env);
  if (!configurationResult.ok) {
    console.error(
      `Cannot migrate because the database configuration is invalid:\n${configurationResult.problems
        .map((problem) => `  - ${problem}`)
        .join("\n")}`,
    );
    process.exitCode = 1;
    return;
  }
  const { configuration } = configurationResult;
  if (configuration === undefined) {
    console.error("Cannot migrate because BARRACK_DATABASE_URL is not set.");
    process.exitCode = 1;
    return;
  }
  const logger = createLogger("info");
  logger.info({ database: locationOf(configuration) }, "Migrating the database");
  const pool = createDatabasePool(configuration, logger);
  try {
    await applyPendingMigrations({ pool, schema: databaseSchema, logger });
  } finally {
    await pool.end();
  }
}

migrate().catch((error: unknown) => {
  console.error("Could not migrate the database:", error);
  process.exitCode = 1;
});
