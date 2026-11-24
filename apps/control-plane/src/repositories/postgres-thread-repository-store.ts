import type { RepositoryAccess } from "@barrack/protocol";
import { escapeIdentifier, type Pool, type PoolClient } from "pg";
import { databaseSchema } from "../thread-event-log/postgres-thread-event-log.js";
import type {
  NewThreadRepository,
  RepositoryPublication,
  ThreadRepositoryRecord,
  ThreadRepositoryStore,
} from "./thread-repository-store.js";

type ThreadRepositoryRow = {
  thread_id: string;
  url: string;
  access: RepositoryAccess;
  base_branch: string | null;
  work_branch: string;
  /** `bigint` columns, which Postgres returns as strings. */
  github_repository_id: string | null;
  github_installation_id: string | null;
  github_full_name: string | null;
  github_html_url: string | null;
  last_published_commit: string | null;
  pull_request_number: number | null;
  pull_request_url: string | null;
};

const repositoryColumns = `thread_id, url, access, base_branch, work_branch, github_repository_id,
  github_installation_id, github_full_name, github_html_url, last_published_commit,
  pull_request_number, pull_request_url`;

function tableIn(schema: string): string {
  return `${escapeIdentifier(schema)}.thread_repositories`;
}

/**
 * Records a new thread's repository, inside the transaction that records the
 * thread (see `PostgresThreadStore.create`), so the two exist together or
 * not at all.
 */
export async function insertThreadRepository(
  client: PoolClient,
  schema: string,
  threadId: string,
  repository: NewThreadRepository,
): Promise<void> {
  const { github } = repository;
  await client.query(
    `insert into ${tableIn(schema)}
      (thread_id, url, access, base_branch, work_branch, github_repository_id,
        github_installation_id, github_full_name, github_html_url)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      threadId,
      repository.url,
      repository.access,
      repository.baseBranch ?? null,
      repository.workBranch,
      github?.repositoryId ?? null,
      github?.installationId ?? null,
      github?.fullName ?? null,
      github?.htmlUrl ?? null,
    ],
  );
}

/** Threads' repositories in the table made by migration 0040; rows go with their threads. */
export class PostgresThreadRepositoryStore implements ThreadRepositoryStore {
  readonly #pool: Pool;
  readonly #table: string;

  constructor(pool: Pool, schema: string = databaseSchema) {
    this.#pool = pool;
    this.#table = tableIn(schema);
  }

  async find(threadId: string): Promise<ThreadRepositoryRecord | undefined> {
    const result = await this.#pool.query<ThreadRepositoryRow>(
      `select ${repositoryColumns} from ${this.#table} where thread_id = $1`,
      [threadId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  async findMany(threadIds: readonly string[]): Promise<Map<string, ThreadRepositoryRecord>> {
    if (threadIds.length === 0) {
      return new Map();
    }
    const result = await this.#pool.query<ThreadRepositoryRow>(
      `select ${repositoryColumns} from ${this.#table} where thread_id = any($1::text[])`,
      [threadIds],
    );
    return new Map(result.rows.map((row) => [row.thread_id, toRecord(row)]));
  }

  async recordPublication(threadId: string, publication: RepositoryPublication): Promise<void> {
    await this.#pool.query(
      `update ${this.#table} set
          last_published_commit = $2, pull_request_number = $3, pull_request_url = $4
        where thread_id = $1`,
      [
        threadId,
        publication.lastPublishedCommit ?? null,
        publication.pullRequest?.number ?? null,
        publication.pullRequest?.url ?? null,
      ],
    );
  }
}

function toRecord(row: ThreadRepositoryRow): ThreadRepositoryRecord {
  return {
    threadId: row.thread_id,
    url: row.url,
    access: row.access,
    baseBranch: row.base_branch ?? undefined,
    workBranch: row.work_branch,
    github: toGithubReference(row),
    lastPublishedCommit: row.last_published_commit ?? undefined,
    pullRequest:
      row.pull_request_number === null || row.pull_request_url === null
        ? undefined
        : { number: row.pull_request_number, url: row.pull_request_url },
  };
}

/** The table's check guarantees all four are set together. */
function toGithubReference(row: ThreadRepositoryRow): NewThreadRepository["github"] {
  if (
    row.github_repository_id === null ||
    row.github_installation_id === null ||
    row.github_full_name === null ||
    row.github_html_url === null
  ) {
    return undefined;
  }
  return {
    repositoryId: Number(row.github_repository_id),
    installationId: Number(row.github_installation_id),
    fullName: row.github_full_name,
    htmlUrl: row.github_html_url,
  };
}
