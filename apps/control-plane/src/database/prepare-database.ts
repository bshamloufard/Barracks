import { setTimeout as sleep } from "node:timers/promises";
import type { Pool } from "pg";
import type { Logger } from "../logger.js";
import { databaseSchema } from "../thread-event-log/postgres-thread-event-log.js";
import type { DatabaseLocation } from "./database-configuration.js";
import { applyPendingMigrations } from "./migration-runner.js";

const firstRetryDelayInMilliseconds = 1_000;
const longestRetryDelayInMilliseconds = 30_000;

/** Errors Node reports when it cannot reach a host at all. */
const networkErrorCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

/** Errors the driver reports when a connection times out or drops. */
const connectionLossMessages = new Set([
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
  "Connection terminated unexpectedly",
  "Query read timeout",
]);

/**
 * Migrates the database before the control plane accepts connections,
 * waiting for it as long as it takes to become reachable. Exiting instead
 * would have the host restart the process in a loop; waiting keeps the
 * health check failing, so a deployment that cannot reach its database
 * never replaces one that can. Errors that waiting cannot fix, such as a
 * refused password, a certificate that does not verify or a migration that
 * fails, are thrown.
 */
export async function migrateOnceDatabaseIsReachable(
  pool: Pool,
  location: DatabaseLocation,
  logger: Logger,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await applyPendingMigrations({ pool, schema: databaseSchema, logger });
      return;
    } catch (error) {
      // A connection lost part way through a migration is wrapped in an
      // error naming the migration, which rolled back and can be retried.
      const isUnreachable =
        isDatabaseUnreachable(error) ||
        (error instanceof Error && isDatabaseUnreachable(error.cause));
      if (!isUnreachable) {
        throw error;
      }
      const retryDelayInMilliseconds = Math.min(
        firstRetryDelayInMilliseconds * 2 ** (attempt - 1),
        longestRetryDelayInMilliseconds,
      );
      logger.error(
        { err: error, database: location, attempt, retryDelayInMilliseconds },
        "Could not reach the database to migrate it; trying again",
      );
      await sleep(retryDelayInMilliseconds);
    }
  }
}

/**
 * Connection failures, and the Postgres error classes for a server that is
 * unavailable: connection exceptions (08), a server starting up or shutting
 * down (57P), and too many connections (53300).
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export function isDatabaseUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (connectionLossMessages.has(error.message)) {
    return true;
  }
  const code = "code" in error ? error.code : undefined;
  if (typeof code !== "string") {
    return false;
  }
  return (
    networkErrorCodes.has(code) ||
    code.startsWith("08") ||
    code.startsWith("57P") ||
    code === "53300"
  );
}
