import { escapeIdentifier, type Pool } from "pg";
import { z } from "zod";
import { databaseSchema } from "../thread-event-log/postgres-thread-event-log.js";
import type {
  GithubConnectionAttempt,
  GithubConnectionRecord,
  GithubConnectionStore,
  LinkedGithubRepository,
} from "./github-connection-store.js";

type ConnectionRow = {
  user_id: string;
  /** A `bigint`, which Postgres returns as a string. */
  github_user_id: string;
  github_login: string;
  github_name: string | null;
  connected_at: Date;
  repositories: unknown;
};

type AttemptRow = {
  state_digest: Buffer;
  user_id: string;
  code_verifier: string;
  expires_at: Date;
};

const linkedRepositoriesSchema = z.array(
  z.object({
    id: z.number(),
    fullName: z.string(),
    installationId: z.number(),
    defaultBranch: z.string(),
    cloneUrl: z.string(),
    htmlUrl: z.string(),
    isPrivate: z.boolean(),
  }),
);

/** GitHub links in the tables made by migration 0040. */
export class PostgresGithubConnectionStore implements GithubConnectionStore {
  readonly #pool: Pool;
  readonly #connections: string;
  readonly #attempts: string;

  constructor(pool: Pool, schema: string = databaseSchema) {
    this.#pool = pool;
    this.#connections = `${escapeIdentifier(schema)}.github_connections`;
    this.#attempts = `${escapeIdentifier(schema)}.github_connection_attempts`;
  }

  /** One statement, so the user's earlier attempts and expired ones go as this one arrives. */
  async saveAttempt(attempt: GithubConnectionAttempt): Promise<void> {
    await this.#pool.query(
      `with forgotten as (
          delete from ${this.#attempts} where user_id = $2 or expires_at < now()
        )
        insert into ${this.#attempts} (state_digest, user_id, code_verifier, expires_at)
        values ($1, $2, $3, $4)`,
      [attempt.stateDigest, attempt.userId, attempt.codeVerifier, attempt.expiresAt],
    );
  }

  async takeAttempt(stateDigest: Buffer): Promise<GithubConnectionAttempt | undefined> {
    const result = await this.#pool.query<AttemptRow>(
      `delete from ${this.#attempts} where state_digest = $1
        returning state_digest, user_id, code_verifier, expires_at`,
      [stateDigest],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          stateDigest: row.state_digest,
          userId: row.user_id,
          codeVerifier: row.code_verifier,
          expiresAt: row.expires_at,
        };
  }

  async save(connection: GithubConnectionRecord): Promise<void> {
    await this.#pool.query(
      `insert into ${this.#connections}
        (user_id, github_user_id, github_login, github_name, connected_at, repositories)
        values ($1, $2, $3, $4, $5, $6)
        on conflict (user_id) do update set
          github_user_id = excluded.github_user_id,
          github_login = excluded.github_login,
          github_name = excluded.github_name,
          connected_at = excluded.connected_at,
          repositories = excluded.repositories`,
      [
        connection.userId,
        connection.githubUserId,
        connection.login,
        connection.name ?? null,
        connection.connectedAt,
        JSON.stringify(connection.repositories),
      ],
    );
  }

  async find(userId: string): Promise<GithubConnectionRecord | undefined> {
    const result = await this.#pool.query<ConnectionRow>(
      `select user_id, github_user_id, github_login, github_name, connected_at, repositories
        from ${this.#connections} where user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toConnection(row);
  }

  async remove(userId: string): Promise<void> {
    await this.#pool.query(`delete from ${this.#connections} where user_id = $1`, [userId]);
  }
}

function toConnection(row: ConnectionRow): GithubConnectionRecord {
  const repositories: LinkedGithubRepository[] = linkedRepositoriesSchema.parse(row.repositories);
  return {
    userId: row.user_id,
    githubUserId: Number(row.github_user_id),
    login: row.github_login,
    name: row.github_name ?? undefined,
    connectedAt: row.connected_at,
    repositories,
  };
}
