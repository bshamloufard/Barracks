import { type DatabaseConfiguration, locationOf } from "../database/database-configuration.js";
import { createDatabasePool } from "../database/database-pool.js";
import { migrateOnceDatabaseIsReachable } from "../database/prepare-database.js";
import type { Logger } from "../logger.js";
import { InMemoryThreadEventLog } from "../thread-event-log/in-memory-thread-event-log.js";
import { PostgresThreadEventLog } from "../thread-event-log/postgres-thread-event-log.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import { InMemoryThreadStore } from "../threads/in-memory-thread-store.js";
import { PostgresThreadStore } from "../threads/postgres-thread-store.js";
import type { ThreadStore } from "../threads/thread-store.js";
import { InMemoryUserStore } from "../users/in-memory-user-store.js";
import { PostgresUserStore } from "../users/postgres-user-store.js";
import type { UserStore } from "../users/user-store.js";

/** Where the control plane keeps users, threads and their history. */
export type OpenStorage = {
  threadEventLog: ThreadEventLog;
  threadStore: ThreadStore;
  userStore: UserStore;
  /** Releases what storage holds open, such as its database connections. */
  close(): Promise<void>;
};

/** Node's codes for a server certificate that could not be verified. */
const certificateVerificationErrorCodes = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Postgres, with its schema migrated, when a database is configured;
 * otherwise memory, with a warning that threads and their history will not
 * survive a restart.
 */
export async function openStorage(
  database: DatabaseConfiguration | undefined,
  logger: Logger,
): Promise<OpenStorage> {
  if (database === undefined) {
    logger.warn(
      "BARRACK_DATABASE_URL is not set, so threads and their history are kept in memory and LOST whenever the control plane stops. That suits local development only; never deploy without a database.",
    );
    return {
      threadEventLog: new InMemoryThreadEventLog(),
      threadStore: new InMemoryThreadStore(),
      userStore: new InMemoryUserStore(),
      close: async () => undefined,
    };
  }
  const location = locationOf(database);
  if (database.tlsMode === "disable") {
    logger.warn(
      { database: location },
      "TLS to the database is disabled, so its password and all thread history cross the network unencrypted",
    );
  }
  logger.info(
    { database: location, poolSize: database.poolSize },
    "Storing threads and their history in Postgres",
  );
  const pool = createDatabasePool(database, logger);
  try {
    await migrateOnceDatabaseIsReachable(pool, location, logger);
  } catch (error) {
    await pool.end();
    throw explainStartFailure(error);
  }
  return {
    threadEventLog: new PostgresThreadEventLog(pool),
    threadStore: new PostgresThreadStore(pool),
    userStore: new PostgresUserStore(pool),
    close: () => pool.end(),
  };
}

/** Adds what to do about the failures a deployer is most likely to meet first. */
function explainStartFailure(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string" && certificateVerificationErrorCodes.has(code)) {
    return new Error(
      "The database's TLS certificate could not be verified. If a private authority signed it, as Supabase's does, set BARRACK_DATABASE_CA_CERTIFICATE to that authority's certificate.",
      { cause: error },
    );
  }
  if (error.message === "The server does not support SSL connections") {
    return new Error(
      "The database does not accept TLS. Set BARRACK_DATABASE_TLS=disable only if it is on this machine or a private network.",
      { cause: error },
    );
  }
  return error;
}
