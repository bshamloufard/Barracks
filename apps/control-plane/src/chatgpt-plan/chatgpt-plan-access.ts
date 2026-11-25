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
  /** Undefined where the plan is not offered. */
  client: ChatGptSignInClient | undefined;
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
  readonly #client: ChatGptSignInClient | undefined;
  readonly #clock: () => Date;
  readonly #logger: Logger;
  readonly #sleep: (milliseconds: number) => Promise<void>;

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
      openAiAccess: this.isOffered ? (plan?.openAiAccess ?? "api_key") : "api_key",
    };
  }

  /**
   * What the owner's threads spend on `providerId`'s models: their plan
   * for OpenAI's when the installation offers it and they chose it, even
   * while it is not connected, so a lost plan stops their threads with a
   * reason rather than quietly spending their API key instead (OpenAI
   * itself never moves plan requests to another way of paying).
   */
  async findAccess(ownerUserId: string, providerId: string): Promise<ProviderAccess> {
    if (!this.isOffered || providerId !== chatGptPlanProviderId) {
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
    const renewed = await this.#store.renew(ownerUserId, (locked) =>
      locked === undefined || !this.#isRenewalDue(locked)
        ? Promise.resolve({ kind: "keep" })
        : this.#renew(ownerUserId, locked),
    );
    return renewed === undefined
      ? { kind: "not_connected" }
      : { kind: "token", accessToken: renewed.tokens.accessToken };
  }

  /**
   * OpenAI refused `refusedAccessToken` as no longer valid: renews the
   * sign-in at once, unless it was renewed since, so the next request has
   * a good token, or the user is told to connect again if it cannot be.
   */
  async renewAfterRefusal(ownerUserId: string, refusedAccessToken: string): Promise<void> {
    await this.#store.renew(ownerUserId, (locked) =>
      locked === undefined || locked.tokens.accessToken !== refusedAccessToken
        ? Promise.resolve({ kind: "keep" })
        : this.#renew(ownerUserId, locked),
    );
  }

  /**
   * Revokes the owner's sign-in at OpenAI and forgets it; their threads go
   * back to their API key. Undefined when nothing was connected.
   */
  async disconnect(
    ownerUserId: string,
  ): Promise<Pick<ChatGptPlanDisconnection, "revocation"> | undefined> {
    const removed = await this.#store.disconnect(ownerUserId);
    if (removed === undefined) {
      return undefined;
    }
    const clientId = (await this.#store.findPlan(ownerUserId))?.clientId;
    const isRevoked = clientId !== undefined && (await this.#revoke(clientId, removed));
    this.#logger.info({ ownerUserId, isRevoked }, "Disconnected a user's ChatGPT plan");
    return { revocation: isRevoked ? "revoked" : "not_confirmed" };
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

  /** Spends the refresh token for a new one; only ever called holding the sign-in alone. */
  async #renew(ownerUserId: string, signIn: PlanSignIn): Promise<Renewal> {
    const client = this.#requireClient();
    const clientId = (await this.#store.findPlan(ownerUserId))?.clientId;
    if (clientId === undefined) {
      return this.#forget(ownerUserId, "the issued client is gone", false);
    }
    const outcome = await client.renew({ clientId, refreshToken: signIn.tokens.refreshToken });
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

  async #revoke(clientId: string, signIn: PlanSignIn): Promise<boolean> {
    const client = this.#requireClient();
    const request = { clientId, refreshToken: signIn.tokens.refreshToken };
    for (const delay of [0, ...revocationRetryDelaysInMilliseconds]) {
      await this.#sleep(delay);
      if (await client.revoke(request)) {
        return true;
      }
    }
    return false;
  }

  #requireClient(): ChatGptSignInClient {
    if (this.#client === undefined) {
      throw new Error("This installation does not offer ChatGPT plans.");
    }
    return this.#client;
  }
}
