import type {
  ChatGptPlanDisconnection,
  ChatGptPlanStatus,
  ProviderAccess,
} from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { ChatGptPlanSettings } from "./chatgpt-plan-settings.js";
import type { ChatGptPlanStore, PlanSignIn, Renewal } from "./chatgpt-plan-store.js";
import type { ChatGptSignInClient } from "./chatgpt-sign-in-client.js";

/** The one provider whose requests can run on a ChatGPT plan. */
export const chatGptPlanProviderId = "openai";

/**
 * Renewed this long before its access token expires (it lasts an hour), so
 * a request never starts with a token about to lapse.
 */
export const renewalMarginInMilliseconds = 5 * 60_000;

/**
 * OpenAI may say when a sign-in may first be renewed (`earliest_refresh_at`);
 * that is waited for, unless the access token would otherwise lapse
 * within this.
 */
const lastMomentInMilliseconds = 30_000;

/** Tries at revoking, with the waits between them, since the documentation asks for retries with backoff. */
const revocationRetryDelaysInMilliseconds = [500, 1_000, 2_000];

/** What a thread's requests on the plan can be sent with now. */
export type PlanAccessToken = { kind: "token"; accessToken: string } | { kind: "not_connected" };

/**
 * After OpenAI refused an access token: a token to try instead, none since
 * the plan is no longer connected, or none yet, since OpenAI said the
 * sign-in may not be renewed so soon (`earliest_refresh_at`).
 */
export type PlanRefusalRenewal = PlanAccessToken | { kind: "not_renewable_yet" };

/**
 * OpenAI could not renew the sign-in just now (it could not be reached, or
 * failed): the sign-in is kept, and the request is worth retrying.
 */
export class PlanRenewalUnavailableError extends Error {
  constructor(readonly code: string | undefined) {
    super(`OpenAI could not renew the ChatGPT plan's sign-in just now (${code ?? "no answer"}).`);
    this.name = "PlanRenewalUnavailableError";
  }
}

export type ChatGptPlanAccessOptions = {
  settings: ChatGptPlanSettings;
  store: ChatGptPlanStore;
  /** Present wherever a sign-in may be kept, offered or not, so it can be renewed or revoked. */
  client: ChatGptSignInClient;
  clock?: () => Date;
  logger: Logger;
  /** Waits between revocation tries; tests make them short. */
  sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * Each user's ChatGPT plan once connected: what their threads spend on
 * OpenAI models, a current access token for the model proxy to send with
 * their own threads' requests, and disconnecting. The refresh token never
 * leaves the control plane; the access token leaves it only towards
 * OpenAI, attached by the proxy.
 *
 * A sign-in is renewed when a request finds its access token within five
 * minutes of expiring, through `ChatGptPlanStore.renew`, which holds that
 * user's sign-in alone across every control plane: a second request
 * waiting on it finds it renewed and uses the new token. One OpenAI will
 * not renew is forgotten, and the user is told to connect again.
 */
export class ChatGptPlanAccess {
  readonly #settings: ChatGptPlanSettings;
  readonly #store: ChatGptPlanStore;
  readonly #client: ChatGptSignInClient;
  readonly #clock: () => Date;
  readonly #logger: Logger;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  /** Each user's renewal under way in this process, which the others wait for rather than queue at the store. */
  readonly #renewalsUnderWay = new Map<string, Promise<PlanSignIn | undefined>>();
  /** The same, for renewals after OpenAI refused a token, which requests refused meanwhile share. */
  readonly #refusalRenewalsUnderWay = new Map<string, Promise<PlanSignIn | undefined>>();

  constructor(options: ChatGptPlanAccessOptions) {
    this.#settings = options.settings;
    this.#store = options.store;
    this.#client = options.client;
    this.#clock = options.clock ?? (() => new Date());
    this.#logger = options.logger;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  get isOffered(): boolean {
    return this.#settings.isOffered;
  }

  async describe(ownerUserId: string): Promise<ChatGptPlanStatus> {
    const plan = await this.#store.findPlan(ownerUserId);
    const signIn = plan === undefined ? undefined : await this.#store.readSignIn(ownerUserId);
    return {
      availability: this.isOffered ? "available" : "turned_off",
      connection:
        signIn === undefined
          ? null
          : {
              connectedAt: signIn.connectedAt.toISOString(),
              accountEmail: signIn.accountEmail ?? null,
            },
      loss:
        plan?.loss === undefined
          ? null
          : { reason: plan.loss.reason, at: plan.loss.at.toISOString() },
      openAiAccess: plan?.openAiAccess ?? "api_key",
    };
  }

  /**
   * What the owner's threads spend on `providerId`'s models: their plan for
   * OpenAI's when they chose it, even while it is not connected, and even
   * where the installation no longer offers plans, so a plan they cannot
   * use stops their threads with a reason rather than quietly spending
   * their API key instead (OpenAI itself never moves plan requests to
   * another way of paying). Only the user moves them to their key.
   */
  async findAccess(ownerUserId: string, providerId: string): Promise<ProviderAccess> {
    if (providerId !== chatGptPlanProviderId) {
      return "api_key";
    }
    return (await this.#store.findPlan(ownerUserId))?.openAiAccess ?? "api_key";
  }

  async isConnected(ownerUserId: string): Promise<boolean> {
    return this.isOffered && (await this.#store.readSignIn(ownerUserId)) !== undefined;
  }

  /** False, changing nothing, for the plan while it is not connected. */
  async setOpenAiAccess(ownerUserId: string, access: ProviderAccess): Promise<boolean> {
    if (access === "chatgpt_plan" && !(await this.isConnected(ownerUserId))) {
      return false;
    }
    if ((await this.#store.findPlan(ownerUserId)) === undefined) {
      // Only someone who has connected a plan has a record; choosing the key needs none.
      return access === "api_key";
    }
    await this.#store.setOpenAiAccess(ownerUserId, access);
    this.#logger.info(
      { ownerUserId, access },
      "Changed what a user's threads spend on OpenAI models",
    );
    return true;
  }

  /**
   * An access token for the owner's plan, renewed first if it is due.
   * Throws `PlanRenewalUnavailableError` when it is due and OpenAI cannot
   * renew it just now.
   */
  async findAccessToken(ownerUserId: string): Promise<PlanAccessToken> {
    if (!this.isOffered) {
      return { kind: "not_connected" };
    }
    const current = await this.#store.readSignIn(ownerUserId);
    if (current === undefined) {
      return { kind: "not_connected" };
    }
    if (!this.#isRenewalDue(current)) {
      return { kind: "token", accessToken: current.tokens.accessToken };
    }
    const renewed = await this.#renewOncePerProcess(ownerUserId);
    return renewed === undefined
      ? { kind: "not_connected" }
      : { kind: "token", accessToken: renewed.tokens.accessToken };
  }

  /**
   * OpenAI refused `refusedAccessToken` as no longer valid: renews the
   * sign-in at once, unless it was renewed since or OpenAI said it may not
   * be renewed yet, or forgets it if OpenAI will not renew it. Requests on
   * this control plane refused meanwhile share the one renewal, so however
   * many are refused at once, a sign-in is renewed once, and no more often
   * than OpenAI allows. Throws `PlanRenewalUnavailableError` when OpenAI
   * cannot renew it just now.
   */
  async renewAfterRefusal(
    ownerUserId: string,
    refusedAccessToken: string,
  ): Promise<PlanRefusalRenewal> {
    const current = await this.#renewAfterRefusalOncePerProcess(ownerUserId, refusedAccessToken);
    if (current === undefined) {
      return { kind: "not_connected" };
    }
    return current.tokens.accessToken === refusedAccessToken
      ? { kind: "not_renewable_yet" }
      : { kind: "token", accessToken: current.tokens.accessToken };
  }

  #renewAfterRefusalOncePerProcess(
    ownerUserId: string,
    refusedAccessToken: string,
  ): Promise<PlanSignIn | undefined> {
    const underWay = this.#refusalRenewalsUnderWay.get(ownerUserId);
    if (underWay !== undefined) {
      return underWay;
    }
    const renewal = this.#store
      .renew(ownerUserId, (locked) =>
        locked === undefined ||
        locked.tokens.accessToken !== refusedAccessToken ||
        this.#isBeforeEarliestRenewal(locked)
          ? Promise.resolve({ kind: "keep" })
          : this.#renew(ownerUserId, locked),
      )
      .finally(() => this.#refusalRenewalsUnderWay.delete(ownerUserId));
    this.#refusalRenewalsUnderWay.set(ownerUserId, renewal);
    return renewal;
  }

  #isBeforeEarliestRenewal(signIn: PlanSignIn): boolean {
    const earliest = signIn.earliestRenewalAt?.getTime();
    return earliest !== undefined && this.#clock().getTime() < earliest;
  }

  /**
   * Revokes the owner's sign-in at OpenAI and forgets it; their threads go
   * back to their API key. Undefined when nothing was connected. Works
   * where the installation no longer offers plans, so a sign-in kept from
   * when it did can still be revoked and removed.
   */
  async disconnect(
    ownerUserId: string,
  ): Promise<Pick<ChatGptPlanDisconnection, "revocation"> | undefined> {
    const removed = await this.#store.disconnect(ownerUserId);
    if (removed === undefined) {
      return undefined;
    }
    const isRevoked = await this.#revoke(removed);
    this.#logger.info({ ownerUserId, isRevoked }, "Disconnected a user's ChatGPT plan");
    return { revocation: isRevoked ? "revoked" : "not_confirmed" };
  }

  /**
   * Renews the owner's sign-in if it is still due once held alone. Requests
   * on this control plane that find it due meanwhile share the one renewal,
   * so each holds no database connection of its own while it waits; the
   * store's lock is what keeps two control planes from renewing at once.
   */
  #renewOncePerProcess(ownerUserId: string): Promise<PlanSignIn | undefined> {
    const underWay = this.#renewalsUnderWay.get(ownerUserId);
    if (underWay !== undefined) {
      return underWay;
    }
    const renewal = this.#store
      .renew(ownerUserId, (locked) =>
        locked === undefined || !this.#isRenewalDue(locked)
          ? Promise.resolve({ kind: "keep" })
          : this.#renew(ownerUserId, locked),
      )
      .finally(() => this.#renewalsUnderWay.delete(ownerUserId));
    this.#renewalsUnderWay.set(ownerUserId, renewal);
    return renewal;
  }

  #isRenewalDue(signIn: PlanSignIn): boolean {
    const now = this.#clock().getTime();
    const expiresAt = signIn.accessExpiresAt.getTime();
    if (now < expiresAt - renewalMarginInMilliseconds) {
      return false;
    }
    const earliest = signIn.earliestRenewalAt?.getTime();
    return earliest === undefined || now >= earliest || now >= expiresAt - lastMomentInMilliseconds;
  }

  /**
   * Spends the refresh token for a new one; only ever called holding the
   * sign-in alone, and asking the store for nothing more meanwhile, since
   * every other renewal waiting may be holding a connection of its own.
   */
  async #renew(ownerUserId: string, signIn: PlanSignIn): Promise<Renewal> {
    const outcome = await this.#client.renew({
      clientId: signIn.clientId,
      refreshToken: signIn.tokens.refreshToken,
    });
    if (outcome.kind === "issued") {
      const now = this.#clock();
      this.#logger.info({ ownerUserId }, "Renewed a user's ChatGPT plan sign-in");
      return {
        kind: "replace",
        signIn: {
          ...signIn,
          tokens: {
            accessToken: outcome.tokens.accessToken,
            refreshToken: outcome.tokens.refreshToken,
          },
          accessExpiresAt: new Date(now.getTime() + outcome.tokens.expiresInSeconds * 1000),
          earliestRenewalAt: outcome.tokens.earliestRenewalAt,
          renewedAt: now,
        },
      };
    }
    if (outcome.reason === "unusable" || outcome.reason === "client_rejected") {
      return this.#forget(
        ownerUserId,
        outcome.code ?? outcome.reason,
        outcome.reason === "client_rejected",
      );
    }
    throw new PlanRenewalUnavailableError(outcome.code);
  }

  #forget(ownerUserId: string, why: string, forgetsClient: boolean): Renewal {
    this.#logger.warn(
      { ownerUserId, why },
      "OpenAI would not renew a user's ChatGPT plan sign-in; it is forgotten, and they must connect again",
    );
    return {
      kind: "forget",
      loss: { reason: "sign_in_expired", at: this.#clock() },
      forgetsClient,
    };
  }

  async #revoke(signIn: PlanSignIn): Promise<boolean> {
    const client = this.#client;
    const request = { clientId: signIn.clientId, refreshToken: signIn.tokens.refreshToken };
    for (const delay of [0, ...revocationRetryDelaysInMilliseconds]) {
      await this.#sleep(delay);
      if (await client.revoke(request)) {
        return true;
      }
    }
    return false;
  }
}
