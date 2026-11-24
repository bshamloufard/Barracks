import type { Pool } from "pg";
import { type DatabaseConfiguration, locationOf } from "../database/database-configuration.js";
import {
  type DatabaseKeepAlive,
  keepAliveQueryFor,
  startDatabaseKeepAlive,
} from "../database/database-keep-alive.js";
import { createDatabasePool } from "../database/database-pool.js";
import { migrateOnceDatabaseIsReachable } from "../database/prepare-database.js";
import type { GithubConnectionStore } from "../github/github-connection-store.js";
import { InMemoryGithubConnectionStore } from "../github/in-memory-github-connection-store.js";
import { PostgresGithubConnectionStore } from "../github/postgres-github-connection-store.js";
import type { Logger } from "../logger.js";
import type { CredentialKeyring } from "../model-access/credential-keyring.js";
import { InMemoryModelCredentialStore } from "../model-access/in-memory-model-credential-store.js";
import type { ModelCredentialStore } from "../model-access/model-credential-store.js";
import { PostgresModelCredentialStore } from "../model-access/postgres-model-credential-store.js";
import { PostgresThreadRepositoryStore } from "../repositories/postgres-thread-repository-store.js";
import type { ThreadRepositoryStore } from "../repositories/thread-repository-store.js";
import { InMemoryThreadEventLog } from "../thread-event-log/in-memory-thread-event-log.js";
import {
  databaseSchema,
  PostgresThreadEventLog,
} from "../thread-event-log/postgres-thread-event-log.js";
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
  /** The repository each thread started from; written with the thread by `threadStore`. */
  threadRepositoryStore: ThreadRepositoryStore;
  githubConnectionStore: GithubConnectionStore;
  /** Users' model credentials, sealed under `keyring`. */
  modelCredentialStore: ModelCredentialStore;
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
  keyring: CredentialKeyring,
  logger: Logger,
): Promise<OpenStorage> {
  if (database === undefined) {
    logger.warn(
      "BARRACK_DATABASE_URL is not set, so threads and their history are kept in memory and LOST whenever the control plane stops. That suits local development only; never deploy without a database.",
    );
    const threadStore = new InMemoryThreadStore();
    return {
      threadEventLog: new InMemoryThreadEventLog(),
      threadStore,
      userStore: new InMemoryUserStore(),
      threadRepositoryStore: threadStore.repositories,
      githubConnectionStore: new InMemoryGithubConnectionStore(),
      modelCredentialStore: new InMemoryModelCredentialStore(keyring),
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
  const keepAlive = startKeepAliveIfConfigured(database, pool, logger);
  return {
    threadEventLog: new PostgresThreadEventLog(pool),
    threadStore: new PostgresThreadStore(pool),
    userStore: new PostgresUserStore(pool),
    threadRepositoryStore: new PostgresThreadRepositoryStore(pool),
    githubConnectionStore: new PostgresGithubConnectionStore(pool),
    modelCredentialStore: new PostgresModelCredentialStore(pool, keyring),
    close: async () => {
      await keepAlive?.stop();
      await pool.end();
    },
  };
}

function startKeepAliveIfConfigured(
  database: DatabaseConfiguration,
  pool: Pool,
  logger: Logger,
): DatabaseKeepAlive | undefined {
  const intervalInMilliseconds = database.keepAliveIntervalInMilliseconds;
  if (intervalInMilliseconds === undefined) {
    return undefined;
  }
  logger.info(
    { keepAliveIntervalInMinutes: intervalInMilliseconds / 60_000 },
    "Querying the database at this interval even when idle, so that a free Supabase project is not paused for inactivity",
  );
  return startDatabaseKeepAlive({
    runQuery: keepAliveQueryFor(pool, databaseSchema),
    intervalInMilliseconds,
    logger,
  });
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
