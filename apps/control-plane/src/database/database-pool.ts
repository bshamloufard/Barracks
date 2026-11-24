import type { ConnectionOptions } from "node:tls";
import { Pool } from "pg";
import type { Logger } from "../logger.js";
import { type DatabaseConfiguration, locationOf } from "./database-configuration.js";

/**
 * Without a limit, a query to an unreachable database waits for the
 * operating system to give up on the connection, which can take minutes,
 * and everything queued behind it in a thread relay waits too.
 */
const connectionTimeoutInMilliseconds = 10_000;

/**
 * The longest a query may take before the control plane stops waiting for
 * it. The slowest expected query reads one page of replayed history, at most
 * a few megabytes.
 */
const queryTimeoutInMilliseconds = 30_000;

/**
 * Agent events arrive in bursts separated by the model thinking, so idle
 * connections are kept for a minute rather than the driver's ten seconds,
 * sparing a new TLS handshake through the pooler at the start of each burst.
 */
const idleConnectionTimeoutInMilliseconds = 60_000;

/**
 * Opens connections lazily, so creating the pool never fails; the first
 * query reports an unreachable database.
 */
export function createDatabasePool(configuration: DatabaseConfiguration, logger: Logger): Pool {
  const pool = new Pool({
    host: configuration.host,
    port: configuration.port,
    database: configuration.databaseName,
    user: configuration.user,
    password: configuration.password,
    ssl: tlsOptionsFor(configuration),
    max: configuration.poolSize,
    connectionTimeoutMillis: connectionTimeoutInMilliseconds,
    query_timeout: queryTimeoutInMilliseconds,
    idleTimeoutMillis: idleConnectionTimeoutInMilliseconds,
    keepAlive: true,
    application_name: "barrack-control-plane",
  });
  // An idle connection reports the database going away through the pool,
  // and an `error` event without a listener would crash the process. The
  // driver has already discarded the connection, and the next query opens a
  // new one, so logging is all there is to do.
  pool.on("error", (error) => {
    logger.error(
      { err: error, database: locationOf(configuration) },
      "An idle database connection failed; it has been discarded",
    );
  });
  return pool;
}

/** `false` turns TLS off; an options object turns it on with certificate and host name checks. */
function tlsOptionsFor(configuration: DatabaseConfiguration): ConnectionOptions | false {
  if (configuration.tlsMode === "disable") {
    return false;
  }
  return {
    rejectUnauthorized: true,
    ...(configuration.certificateAuthorities === undefined
      ? {}
      : { ca: configuration.certificateAuthorities }),
  };
}
