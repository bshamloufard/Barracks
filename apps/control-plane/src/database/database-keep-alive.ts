import { escapeIdentifier, type Pool } from "pg";
import type { Logger } from "../logger.js";

/**
 * Keeps a free Supabase project from being paused while nobody uses Barrack.
 *
 * Supabase pauses a free project that "does not receive sufficient user
 * database activity over the past week", adding that "typically a few user
 * requests to the database each day over the previous week is enough".
 * https://supabase.com/docs/guides/platform/free-project-pausing
 *
 * An always-on control plane queries the database only when a thread is
 * created or used, so a quiet week would pause the project and the next
 * visit would find the control plane unable to reach its database. Supabase
 * does not say which queries count, so the keep-alive reads one of Barrack's
 * own tables, through the same role and pooler as every other query, rather
 * than sending a bare `select 1`.
 */

export type DatabaseKeepAlive = {
  /** Cancels the next query and waits for one under way, so the pool can then be closed. */
  stop(): Promise<void>;
};

export type DatabaseKeepAliveOptions = {
  /** Runs one keep-alive query; a rejection is logged and the next is still scheduled. */
  runQuery: () => Promise<void>;
  intervalInMilliseconds: number;
  logger: Logger;
};

/** The keep-alive query: one row, at most, from a table every migrated database has. */
export function keepAliveQueryFor(pool: Pool, schema: string): () => Promise<void> {
  const query = `select name from ${escapeIdentifier(schema)}.schema_migrations limit 1`;
  return async () => {
    await pool.query(query);
  };
}

/**
 * Runs the query once per interval. Each query is scheduled only after the
 * previous one has finished, so a slow database never has two at once.
 */
export function startDatabaseKeepAlive(options: DatabaseKeepAliveOptions): DatabaseKeepAlive {
  const { runQuery, intervalInMilliseconds, logger } = options;
  let isStopped = false;
  let nextQueryTimer: NodeJS.Timeout | undefined;
  let queryUnderWay: Promise<void> | undefined;

  const runOnce = (): void => {
    queryUnderWay = runQuery()
      .then(
        () => logger.debug("Queried the database to keep it from being paused for inactivity"),
        (error: unknown) =>
          logger.error(
            { err: error, intervalInMilliseconds },
            "The database keep-alive query failed; it will run again after the next interval",
          ),
      )
      .finally(() => {
        queryUnderWay = undefined;
        scheduleNext();
      });
  };

  const scheduleNext = (): void => {
    if (isStopped) {
      return;
    }
    nextQueryTimer = setTimeout(runOnce, intervalInMilliseconds);
    // The keep-alive alone is no reason for the process to stay up.
    nextQueryTimer.unref();
  };

  scheduleNext();
  return {
    stop: async () => {
      isStopped = true;
      clearTimeout(nextQueryTimer);
      await queryUnderWay;
    },
  };
}
