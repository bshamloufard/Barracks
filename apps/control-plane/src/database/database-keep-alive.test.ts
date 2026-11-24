import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestPool,
  describeWithTestDatabase,
  silentLogger,
  TestSchemas,
} from "../test-support/test-database.js";
import { readDatabaseConfiguration } from "./database-configuration.js";
import { keepAliveQueryFor, startDatabaseKeepAlive } from "./database-keep-alive.js";

const intervalInMilliseconds = 60_000;

/** A query that finishes only when the test says so, counting how often it was started. */
class ControllableQuery {
  startedCount = 0;
  #finishCurrent: ((outcome: Error | undefined) => void) | undefined;

  readonly run = (): Promise<void> => {
    this.startedCount += 1;
    return new Promise((resolve, reject) => {
      this.#finishCurrent = (outcome) => (outcome === undefined ? resolve() : reject(outcome));
    });
  };

  succeed(): void {
    this.#finishCurrent?.(undefined);
  }

  fail(error: Error): void {
    this.#finishCurrent?.(error);
  }
}

describe("the database keep-alive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queries the database once per interval, starting one interval after it starts", async () => {
    const query = new ControllableQuery();
    const keepAlive = startDatabaseKeepAlive({
      runQuery: query.run,
      intervalInMilliseconds,
      logger: silentLogger,
    });

    await vi.advanceTimersByTimeAsync(intervalInMilliseconds - 1);
    expect(query.startedCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(query.startedCount).toBe(1);
    query.succeed();
    await vi.advanceTimersByTimeAsync(intervalInMilliseconds);
    expect(query.startedCount).toBe(2);

    query.succeed();
    await keepAlive.stop();
  });

  it("never starts a query while the previous one is still running", async () => {
    const query = new ControllableQuery();
    const keepAlive = startDatabaseKeepAlive({
      runQuery: query.run,
      intervalInMilliseconds,
      logger: silentLogger,
    });

    await vi.advanceTimersByTimeAsync(5 * intervalInMilliseconds);
    expect(query.startedCount).toBe(1);
    query.succeed();
    await vi.advanceTimersByTimeAsync(intervalInMilliseconds);
    expect(query.startedCount).toBe(2);

    query.succeed();
    await keepAlive.stop();
  });

  it("logs a failed query and carries on at the next interval", async () => {
    const query = new ControllableQuery();
    const logger = silentLogger.child({});
    const logError = vi.spyOn(logger, "error");
    const keepAlive = startDatabaseKeepAlive({
      runQuery: query.run,
      intervalInMilliseconds,
      logger,
    });

    await vi.advanceTimersByTimeAsync(intervalInMilliseconds);
    query.fail(new Error("Connection terminated unexpectedly"));
    await vi.advanceTimersByTimeAsync(intervalInMilliseconds);

    expect(logError).toHaveBeenCalledOnce();
    expect(query.startedCount).toBe(2);
    query.succeed();
    await keepAlive.stop();
  });

  it("waits for a query under way when stopped, and starts no more", async () => {
    const query = new ControllableQuery();
    const keepAlive = startDatabaseKeepAlive({
      runQuery: query.run,
      intervalInMilliseconds,
      logger: silentLogger,
    });
    await vi.advanceTimersByTimeAsync(intervalInMilliseconds);

    let hasStopped = false;
    const stopping = keepAlive.stop().then(() => {
      hasStopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(hasStopped).toBe(false);
    query.succeed();
    await stopping;
    await vi.advanceTimersByTimeAsync(10 * intervalInMilliseconds);

    expect(query.startedCount).toBe(1);
  });
});

describe("the keep-alive interval setting", () => {
  const databaseUrl = "postgres://barrack:secret@db.example:5432/barrack";

  it("is four hours unless set", () => {
    const result = readDatabaseConfiguration({ BARRACK_DATABASE_URL: databaseUrl });

    expect(result.ok && result.configuration?.keepAliveIntervalInMilliseconds).toBe(
      4 * 60 * 60 * 1000,
    );
  });

  it("is given in minutes, and 0 turns the keep-alive off", () => {
    const every30Minutes = readDatabaseConfiguration({
      BARRACK_DATABASE_URL: databaseUrl,
      BARRACK_DATABASE_KEEP_ALIVE_MINUTES: "30",
    });
    const off = readDatabaseConfiguration({
      BARRACK_DATABASE_URL: databaseUrl,
      BARRACK_DATABASE_KEEP_ALIVE_MINUTES: "0",
    });

    expect(every30Minutes.ok && every30Minutes.configuration?.keepAliveIntervalInMilliseconds).toBe(
      30 * 60 * 1000,
    );
    expect(off.ok && off.configuration).toMatchObject({
      keepAliveIntervalInMilliseconds: undefined,
    });
  });

  it("refuses an interval longer than a day, which could let a free project pause", () => {
    const result = readDatabaseConfiguration({
      BARRACK_DATABASE_URL: databaseUrl,
      BARRACK_DATABASE_KEEP_ALIVE_MINUTES: "1441",
    });

    expect(result).toEqual({
      ok: false,
      problems: [expect.stringMatching(/^BARRACK_DATABASE_KEEP_ALIVE_MINUTES: /)],
    });
  });
});

describeWithTestDatabase("the keep-alive query", () => {
  const pool = createTestPool(1);
  const schemas = new TestSchemas(pool);
  let schema: string;

  beforeAll(async () => {
    schema = await schemas.createMigrated();
  });

  afterAll(async () => {
    await schemas.dropAll();
    await pool.end();
  });

  it("reads one of Barrack's own tables in a migrated database", async () => {
    await expect(keepAliveQueryFor(pool, schema)()).resolves.toBeUndefined();
  });
});
