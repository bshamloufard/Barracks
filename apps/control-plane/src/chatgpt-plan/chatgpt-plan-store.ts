import type { ChatGptPlanLossReason, ProviderAccess } from "@barrack/protocol";
import type { ResealingOutcome } from "../model-access/model-credential-store.js";

/**
 * Each user's ChatGPT plan: what OpenAI knows this installation by for them,
 * which of their OpenAI access their threads spend, their connected
 * sign-in, and the sign-ins they have begun. The sign-in's tokens and an
 * attempt's PKCE verifier and nonce are sealed under the configured key,
 * bound to their owner, as users' model keys are; only this store's
 * implementations open them, and nothing here is logged.
 *
 * A sign-in's refresh token rotates, and OpenAI refuses one used twice, so
 * `renew` is the one way to change a connected sign-in: it holds that
 * user's sign-in alone while it decides, across every control plane
 * sharing the store, and keeps what it decided in the same step.
 */
export interface ChatGptPlanStore {
  /** The user's plan, if they ever began a sign-in. */
  findPlan(ownerUserId: string): Promise<ChatGptPlanRecord | undefined>;

  /** The user's plan, recorded with `newHostId` if they have none yet; an existing host id is kept. */
  findOrCreatePlan(ownerUserId: string, newHostId: string): Promise<ChatGptPlanRecord>;

  saveAttempt(attempt: SignInAttempt): Promise<void>;

  /**
   * The attempt whose state has this digest, marked finished at `at`, if it
   * is the user's, unfinished and unexpired; otherwise why not. Another
   * user's attempt is answered as unknown.
   */
  takeAttempt(ownerUserId: string, stateDigest: Buffer, at: Date): Promise<AttemptTaking>;

  /** Removes attempts that expired before `before`. */
  removeAttemptsExpiredBefore(before: Date): Promise<void>;

  /**
   * Keeps the user's newly connected sign-in in place of any before it,
   * remembers the client OpenAI issued, and clears any loss.
   */
  connect(ownerUserId: string, clientId: string, signIn: PlanSignIn): Promise<void>;

  /** The user's connected sign-in, opened, or undefined. */
  readSignIn(ownerUserId: string): Promise<PlanSignIn | undefined>;

  /**
   * Runs `decide` on the user's sign-in as it is now (undefined for none),
   * holding it alone, and keeps what it decides before letting the next
   * caller in: a renewed sign-in in its place, or none, with the loss
   * noted. Answers the sign-in as it is afterwards.
   */
  renew(
    ownerUserId: string,
    decide: (current: PlanSignIn | undefined) => Promise<Renewal>,
  ): Promise<PlanSignIn | undefined>;

  /**
   * Removes the user's sign-in, waiting for any renewal under way, and sets
   * their OpenAI access back to their API key. Answers what was removed,
   * for revoking it at OpenAI.
   */
  disconnect(ownerUserId: string): Promise<PlanSignIn | undefined>;

  /** Forgets the issued client, which OpenAI no longer accepts, and the sign-in made with it. */
  forgetClient(ownerUserId: string): Promise<void>;

  /** Records what the user's threads spend on OpenAI models. */
  setOpenAiAccess(ownerUserId: string, access: ProviderAccess): Promise<void>;

  /** How many sign-ins each key has sealed, by fingerprint, to check at startup. */
  countByKeyFingerprint(): Promise<Map<string, number>>;

  /**
   * Seals again, under the current key, every sign-in a previous key
   * sealed, unless it was renewed meanwhile.
   */
  sealAgainUnderCurrentKey(): Promise<ResealingOutcome>;
}

export type ChatGptPlanRecord = {
  /** The `ext_agent_host_id` OpenAI knows this installation by, for this user. */
  hostId: string;
  /** The client OpenAI issued at the user's first sign-in; undefined before it. */
  clientId: string | undefined;
  openAiAccess: ProviderAccess;
  loss: PlanLoss | undefined;
};

export type PlanLoss = { reason: ChatGptPlanLossReason; at: Date };

/** What the programme's token endpoint gave, which only the control plane ever holds. */
export type PlanTokens = { accessToken: string; refreshToken: string };

export type PlanSignIn = {
  tokens: PlanTokens;
  accessExpiresAt: Date;
  /** OpenAI's `earliest_refresh_at`, if it gave one. */
  earliestRenewalAt: Date | undefined;
  accountSubject: string;
  /** Only when OpenAI says it is verified. */
  accountEmail: string | undefined;
  connectedAt: Date;
  renewedAt: Date;
};

/** What a sign-in begun needs in order to be finished, of which only the digest of its state is kept. */
export type SignInAttempt = {
  ownerUserId: string;
  stateDigest: Buffer;
  /** As sent: `dynamic_agent_client` for a first sign-in, or the issued client. */
  clientId: string;
  redirectUri: string;
  secrets: AttemptSecrets;
  startedAt: Date;
  expiresAt: Date;
};

export type AttemptSecrets = { codeVerifier: string; nonce: string };

export type AttemptTaking =
  | { kind: "taken"; attempt: SignInAttempt }
  | { kind: "unknown" | "finished_already" | "expired" };

/**
 * - `keep`: leave the sign-in as it is (another caller renewed it already).
 * - `replace`: the renewed sign-in, whose refresh token replaces the one
 *   just spent.
 * - `forget`: OpenAI will not renew it: remove it, noting why, and the
 *   issued client too when OpenAI no longer accepts that.
 */
export type Renewal =
  | { kind: "keep" }
  | { kind: "replace"; signIn: PlanSignIn }
  | { kind: "forget"; loss: PlanLoss; forgetsClient: boolean };
