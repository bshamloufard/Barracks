import type { ProviderAccess } from "@barrack/protocol";
import { escapeIdentifier, type Pool, type PoolClient } from "pg";
import type { CredentialKeyring, SealedCredential } from "../model-access/credential-keyring.js";
import { UnreadableCredentialError } from "../model-access/credential-keyring.js";
import type { ResealingOutcome } from "../model-access/model-credential-store.js";
import { databaseSchema } from "../thread-event-log/postgres-thread-event-log.js";
import {
  openAttemptSecrets,
  openPlanTokens,
  sealAttemptSecrets,
  sealPlanTokens,
} from "./chatgpt-plan-sealing.js";
import type {
  AttemptTaking,
  ChatGptPlanRecord,
  ChatGptPlanStore,
  PlanLoss,
  PlanSignIn,
  Renewal,
  SignInAttempt,
} from "./chatgpt-plan-store.js";

type PlanRow = {
  host_id: string;
  client_id: string | null;
  openai_access: ProviderAccess;
  loss_reason: PlanLoss["reason"] | null;
  lost_at: Date | null;
};

type SignInRow = {
  client_id: string;
  key_fingerprint: string;
  nonce: Buffer;
  ciphertext: Buffer;
  access_expires_at: Date;
  earliest_renewal_at: Date | null;
  account_subject: string;
  account_email: string | null;
  connected_at: Date;
  renewed_at: Date;
};

type AttemptRow = {
  user_id: string;
  client_id: string;
  redirect_uri: string;
  key_fingerprint: string;
  nonce: Buffer;
  ciphertext: Buffer;
  started_at: Date;
  expires_at: Date;
  finished_at: Date | null;
};

const planColumns = "host_id, client_id, openai_access, loss_reason, lost_at";
const signInColumns =
  "client_id, key_fingerprint, nonce, ciphertext, access_expires_at, earliest_renewal_at, account_subject, account_email, connected_at, renewed_at";

/**
 * Keeps ChatGPT plans in Postgres, in the tables of
 * `migrations/0140_connect_a_chatgpt_plan.sql`. A renewal takes the user's
 * sign-in row `for update` in a transaction of its own, calls OpenAI while
 * holding it, and writes the replacement before committing, so two
 * renewals of one sign-in, on one control plane or two, never overlap, and
 * a replacement OpenAI gave is never lost to a write that came after it.
 * A control plane that stops mid-renewal leaves the transaction to roll
 * back, and the next renewal finds the refresh token it would have spent.
 */
export class PostgresChatGptPlanStore implements ChatGptPlanStore {
  readonly #pool: Pool;
  readonly #keyring: CredentialKeyring;
  readonly #plans: string;
  readonly #signIns: string;
  readonly #attempts: string;

  constructor(pool: Pool, keyring: CredentialKeyring, schema: string = databaseSchema) {
    this.#pool = pool;
    this.#keyring = keyring;
    const table = (name: string) => `${escapeIdentifier(schema)}.${name}`;
    this.#plans = table("chatgpt_plans");
    this.#signIns = table("chatgpt_plan_sign_ins");
    this.#attempts = table("chatgpt_sign_in_attempts");
  }

  async findPlan(ownerUserId: string): Promise<ChatGptPlanRecord | undefined> {
    const result = await this.#pool.query<PlanRow>(
      `select ${planColumns} from ${this.#plans} where user_id = $1`,
      [ownerUserId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toPlanRecord(row);
  }

  async findOrCreatePlan(ownerUserId: string, newHostId: string): Promise<ChatGptPlanRecord> {
    await this.#pool.query(
      `insert into ${this.#plans} (user_id, host_id) values ($1, $2) on conflict (user_id) do nothing`,
      [ownerUserId, newHostId],
    );
    const plan = await this.findPlan(ownerUserId);
    if (plan === undefined) {
      throw new Error("The user's ChatGPT plan record could not be created.");
    }
    return plan;
  }

  async saveAttempt(attempt: SignInAttempt): Promise<void> {
    const sealed = sealAttemptSecrets(this.#keyring, attempt.ownerUserId, attempt.secrets);
    await this.#pool.query(
      `insert into ${this.#attempts} (state_digest, user_id, client_id, redirect_uri,
          key_fingerprint, nonce, ciphertext, started_at, expires_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        attempt.stateDigest,
        attempt.ownerUserId,
        attempt.clientId,
        attempt.redirectUri,
        sealed.keyFingerprint,
        sealed.nonce,
        sealed.ciphertext,
        attempt.startedAt,
        attempt.expiresAt,
      ],
    );
  }

  /** One conditional update, so an address pasted twice at once is taken once. */
  async takeAttempt(ownerUserId: string, stateDigest: Buffer, at: Date): Promise<AttemptTaking> {
    const taken = await this.#pool.query<AttemptRow>(
      `update ${this.#attempts} set finished_at = $3
        where state_digest = $1 and user_id = $2 and finished_at is null and expires_at > $3
        returning user_id, client_id, redirect_uri, key_fingerprint, nonce, ciphertext,
          started_at, expires_at, finished_at`,
      [stateDigest, ownerUserId, at],
    );
    const row = taken.rows[0];
    if (row !== undefined) {
      return { kind: "taken", attempt: this.#toAttempt(stateDigest, row) };
    }
    const found = await this.#pool.query<Pick<AttemptRow, "finished_at">>(
      `select finished_at from ${this.#attempts} where state_digest = $1 and user_id = $2`,
      [stateDigest, ownerUserId],
    );
    const existing = found.rows[0];
    if (existing === undefined) {
      return { kind: "unknown" };
    }
    return { kind: existing.finished_at === null ? "expired" : "finished_already" };
  }

  async removeAttemptsExpiredBefore(before: Date): Promise<void> {
    await this.#pool.query(`delete from ${this.#attempts} where expires_at < $1`, [before]);
  }

  async connect(ownerUserId: string, signIn: PlanSignIn): Promise<void> {
    await this.#inTransaction(async (client) => {
      await client.query(
        `update ${this.#plans} set client_id = $2, loss_reason = null, lost_at = null
          where user_id = $1`,
        [ownerUserId, signIn.clientId],
      );
      await this.#writeSignIn(client, ownerUserId, signIn);
    });
  }

  async readSignIn(ownerUserId: string): Promise<PlanSignIn | undefined> {
    const result = await this.#pool.query<SignInRow>(
      `select ${signInColumns} from ${this.#signIns} where user_id = $1`,
      [ownerUserId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : this.#toSignIn(ownerUserId, row);
  }

  renew(
    ownerUserId: string,
    decide: (current: PlanSignIn | undefined) => Promise<Renewal>,
  ): Promise<PlanSignIn | undefined> {
    return this.#inTransaction(async (client) => {
      const locked = await client.query<SignInRow>(
        `select ${signInColumns} from ${this.#signIns} where user_id = $1 for update`,
        [ownerUserId],
      );
      const row = locked.rows[0];
      const current = row === undefined ? undefined : this.#toSignIn(ownerUserId, row);
      const renewal = await decide(current);
      switch (renewal.kind) {
        case "keep":
          return current;
        case "replace":
          await this.#writeSignIn(client, ownerUserId, renewal.signIn);
          return renewal.signIn;
        case "forget":
          await client.query(`delete from ${this.#signIns} where user_id = $1`, [ownerUserId]);
          await client.query(
            `update ${this.#plans} set loss_reason = $2, lost_at = $3,
                client_id = case when $4::boolean then null else client_id end
              where user_id = $1`,
            [ownerUserId, renewal.loss.reason, renewal.loss.at, renewal.forgetsClient],
          );
          return undefined;
      }
    });
  }

  disconnect(ownerUserId: string): Promise<PlanSignIn | undefined> {
    return this.#inTransaction(async (client) => {
      const removed = await client.query<SignInRow>(
        `delete from ${this.#signIns} where user_id = $1 returning ${signInColumns}`,
        [ownerUserId],
      );
      await client.query(`update ${this.#plans} set openai_access = 'api_key' where user_id = $1`, [
        ownerUserId,
      ]);
      const row = removed.rows[0];
      return row === undefined ? undefined : this.#toSignIn(ownerUserId, row);
    });
  }

  async forgetClient(ownerUserId: string): Promise<void> {
    await this.#inTransaction(async (client) => {
      await client.query(`delete from ${this.#signIns} where user_id = $1`, [ownerUserId]);
      await client.query(`update ${this.#plans} set client_id = null where user_id = $1`, [
        ownerUserId,
      ]);
    });
  }

  async setOpenAiAccess(ownerUserId: string, access: ProviderAccess): Promise<void> {
    await this.#pool.query(`update ${this.#plans} set openai_access = $2 where user_id = $1`, [
      ownerUserId,
      access,
    ]);
  }

  async countByKeyFingerprint(): Promise<Map<string, number>> {
    const result = await this.#pool.query<{ key_fingerprint: string; count: string }>(
      `select key_fingerprint, count(*) as count from ${this.#signIns} group by key_fingerprint`,
    );
    return new Map(result.rows.map((row) => [row.key_fingerprint, Number(row.count)]));
  }

  /** Each is replaced only if it is still as read, so a renewal meanwhile is not undone. */
  async sealAgainUnderCurrentKey(): Promise<ResealingOutcome> {
    const result = await this.#pool.query<SignInRow & { user_id: string }>(
      `select user_id, ${signInColumns} from ${this.#signIns} where key_fingerprint <> $1`,
      [this.#keyring.currentFingerprint],
    );
    const outcome = { resealedCount: 0, unreadableCount: 0 };
    for (const row of result.rows) {
      let resealed: SealedCredential;
      try {
        const tokens = openPlanTokens(this.#keyring, row.user_id, sealedOf(row));
        resealed = sealPlanTokens(this.#keyring, row.user_id, tokens);
      } catch (error) {
        if (!(error instanceof UnreadableCredentialError)) {
          throw error;
        }
        outcome.unreadableCount += 1;
        continue;
      }
      const update = await this.#pool.query(
        `update ${this.#signIns} set key_fingerprint = $2, nonce = $3, ciphertext = $4
          where user_id = $1 and nonce = $5`,
        [row.user_id, resealed.keyFingerprint, resealed.nonce, resealed.ciphertext, row.nonce],
      );
      outcome.resealedCount += update.rowCount ?? 0;
    }
    return outcome;
  }

  async #writeSignIn(client: PoolClient, ownerUserId: string, signIn: PlanSignIn): Promise<void> {
    const sealed = sealPlanTokens(this.#keyring, ownerUserId, signIn.tokens);
    await client.query(
      `insert into ${this.#signIns} (user_id, ${signInColumns})
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        on conflict (user_id) do update set
          client_id = excluded.client_id,
          key_fingerprint = excluded.key_fingerprint,
          nonce = excluded.nonce,
          ciphertext = excluded.ciphertext,
          access_expires_at = excluded.access_expires_at,
          earliest_renewal_at = excluded.earliest_renewal_at,
          account_subject = excluded.account_subject,
          account_email = excluded.account_email,
          connected_at = excluded.connected_at,
          renewed_at = excluded.renewed_at`,
      [
        ownerUserId,
        signIn.clientId,
        sealed.keyFingerprint,
        sealed.nonce,
        sealed.ciphertext,
        signIn.accessExpiresAt,
        signIn.earliestRenewalAt ?? null,
        signIn.accountSubject,
        signIn.accountEmail ?? null,
        signIn.connectedAt,
        signIn.renewedAt,
      ],
    );
  }

  async #inTransaction<Result>(work: (client: PoolClient) => Promise<Result>): Promise<Result> {
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  #toSignIn(ownerUserId: string, row: SignInRow): PlanSignIn {
    return {
      clientId: row.client_id,
      tokens: openPlanTokens(this.#keyring, ownerUserId, sealedOf(row)),
      accessExpiresAt: row.access_expires_at,
      earliestRenewalAt: row.earliest_renewal_at ?? undefined,
      accountSubject: row.account_subject,
      accountEmail: row.account_email ?? undefined,
      connectedAt: row.connected_at,
      renewedAt: row.renewed_at,
    };
  }

  #toAttempt(stateDigest: Buffer, row: AttemptRow): SignInAttempt {
    return {
      ownerUserId: row.user_id,
      stateDigest,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      secrets: openAttemptSecrets(this.#keyring, row.user_id, sealedOf(row)),
      startedAt: row.started_at,
      expiresAt: row.expires_at,
    };
  }
}

function toPlanRecord(row: PlanRow): ChatGptPlanRecord {
  return {
    hostId: row.host_id,
    clientId: row.client_id ?? undefined,
    openAiAccess: row.openai_access,
    loss:
      row.loss_reason === null || row.lost_at === null
        ? undefined
        : { reason: row.loss_reason, at: row.lost_at },
  };
}

function sealedOf(row: {
  key_fingerprint: string;
  nonce: Buffer;
  ciphertext: Buffer;
}): SealedCredential {
  return { keyFingerprint: row.key_fingerprint, nonce: row.nonce, ciphertext: row.ciphertext };
}
