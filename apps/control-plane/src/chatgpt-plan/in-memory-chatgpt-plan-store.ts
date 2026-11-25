import type { ProviderAccess } from "@barrack/protocol";
import type { CredentialKeyring, SealedCredential } from "../model-access/credential-keyring.js";
import type { ResealingOutcome } from "../model-access/model-credential-store.js";
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

type StoredSignIn = Omit<PlanSignIn, "tokens"> & { sealedTokens: SealedCredential };

type StoredAttempt = Omit<SignInAttempt, "secrets"> & {
  sealedSecrets: SealedCredential;
  finishedAt: Date | undefined;
};

/**
 * Keeps ChatGPT plans in memory, for development and tests: a restart loses
 * them, as it loses everything else then. Sealed as Postgres keeps them, so
 * the same code opens them; one control plane alone uses it, so a renewal
 * is held alone by chaining each user's renewals in this process.
 */
export class InMemoryChatGptPlanStore implements ChatGptPlanStore {
  readonly #keyring: CredentialKeyring;
  readonly #plans = new Map<string, ChatGptPlanRecord>();
  readonly #signIns = new Map<string, StoredSignIn>();
  readonly #attempts = new Map<string, StoredAttempt>();
  /** Each user's latest renewal or disconnection, for the next to wait on. */
  readonly #turns = new Map<string, Promise<unknown>>();

  constructor(keyring: CredentialKeyring) {
    this.#keyring = keyring;
  }

  async findPlan(ownerUserId: string): Promise<ChatGptPlanRecord | undefined> {
    const plan = this.#plans.get(ownerUserId);
    return plan === undefined ? undefined : { ...plan };
  }

  async findOrCreatePlan(ownerUserId: string, newHostId: string): Promise<ChatGptPlanRecord> {
    const plan = this.#plans.get(ownerUserId) ?? {
      hostId: newHostId,
      clientId: undefined,
      openAiAccess: "api_key",
      loss: undefined,
    };
    this.#plans.set(ownerUserId, plan);
    return { ...plan };
  }

  async saveAttempt(attempt: SignInAttempt): Promise<void> {
    const { secrets, ...rest } = attempt;
    this.#attempts.set(attempt.stateDigest.toString("hex"), {
      ...rest,
      sealedSecrets: sealAttemptSecrets(this.#keyring, attempt.ownerUserId, secrets),
      finishedAt: undefined,
    });
  }

  async takeAttempt(ownerUserId: string, stateDigest: Buffer, at: Date): Promise<AttemptTaking> {
    const stored = this.#attempts.get(stateDigest.toString("hex"));
    if (stored === undefined || stored.ownerUserId !== ownerUserId) {
      return { kind: "unknown" };
    }
    if (stored.finishedAt !== undefined) {
      return { kind: "finished_already" };
    }
    if (stored.expiresAt <= at) {
      return { kind: "expired" };
    }
    stored.finishedAt = at;
    return {
      kind: "taken",
      attempt: {
        ownerUserId,
        stateDigest: stored.stateDigest,
        clientId: stored.clientId,
        redirectUri: stored.redirectUri,
        secrets: openAttemptSecrets(this.#keyring, ownerUserId, stored.sealedSecrets),
        startedAt: stored.startedAt,
        expiresAt: stored.expiresAt,
      },
    };
  }

  async removeAttemptsExpiredBefore(before: Date): Promise<void> {
    for (const [key, attempt] of this.#attempts) {
      if (attempt.expiresAt < before) {
        this.#attempts.delete(key);
      }
    }
  }

  connect(ownerUserId: string, signIn: PlanSignIn): Promise<PlanSignIn | undefined> {
    return this.#inTurn(ownerUserId, async () => {
      const replaced = this.#open(ownerUserId);
      const plan = this.#requirePlan(ownerUserId);
      this.#plans.set(ownerUserId, { ...plan, clientId: signIn.clientId, loss: undefined });
      this.#signIns.set(ownerUserId, this.#seal(ownerUserId, signIn));
      return replaced;
    });
  }

  async readSignIn(ownerUserId: string): Promise<PlanSignIn | undefined> {
    return this.#open(ownerUserId);
  }

  renew(
    ownerUserId: string,
    decide: (current: PlanSignIn | undefined) => Promise<Renewal>,
  ): Promise<PlanSignIn | undefined> {
    return this.#inTurn(ownerUserId, async () => {
      const renewal = await decide(this.#open(ownerUserId));
      if (renewal.kind === "replace") {
        this.#signIns.set(ownerUserId, this.#seal(ownerUserId, renewal.signIn));
      }
      if (renewal.kind === "forget") {
        this.#signIns.delete(ownerUserId);
        const plan = this.#requirePlan(ownerUserId);
        const clientId = renewal.forgetsClient ? undefined : plan.clientId;
        this.#plans.set(ownerUserId, { ...plan, clientId, loss: renewal.loss });
      }
      return this.#open(ownerUserId);
    });
  }

  disconnect(ownerUserId: string): Promise<PlanSignIn | undefined> {
    return this.#inTurn(ownerUserId, async () => {
      const removed = this.#open(ownerUserId);
      this.#signIns.delete(ownerUserId);
      const plan = this.#plans.get(ownerUserId);
      if (plan !== undefined) {
        this.#plans.set(ownerUserId, { ...plan, openAiAccess: "api_key" });
      }
      return removed;
    });
  }

  forgetClient(ownerUserId: string, loss: PlanLoss): Promise<PlanSignIn | undefined> {
    return this.#inTurn(ownerUserId, async () => {
      const forgotten = this.#open(ownerUserId);
      const wasConnected = this.#signIns.delete(ownerUserId);
      const plan = this.#plans.get(ownerUserId);
      if (plan !== undefined) {
        this.#plans.set(ownerUserId, {
          ...plan,
          clientId: undefined,
          loss: wasConnected ? loss : plan.loss,
        });
      }
      return forgotten;
    });
  }

  async setOpenAiAccess(ownerUserId: string, access: ProviderAccess): Promise<void> {
    const plan = this.#requirePlan(ownerUserId);
    this.#plans.set(ownerUserId, { ...plan, openAiAccess: access });
  }

  async countByKeyFingerprint(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const signIn of this.#signIns.values()) {
      const fingerprint = signIn.sealedTokens.keyFingerprint;
      counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
    }
    return counts;
  }

  async sealAgainUnderCurrentKey(): Promise<ResealingOutcome> {
    // Only a key held in memory could have sealed these: there is no previous one.
    return { resealedCount: 0, unreadableCount: 0 };
  }

  /**
   * Runs `work` once every earlier turn of the user's has ended, however it
   * ended: a turn that failed has given its error to its own caller.
   */
  #inTurn<Result>(ownerUserId: string, work: () => Promise<Result>): Promise<Result> {
    const previous = this.#turns.get(ownerUserId) ?? Promise.resolve();
    const turn = previous.then(work, work);
    this.#turns.set(ownerUserId, turn);
    return turn;
  }

  #requirePlan(ownerUserId: string): ChatGptPlanRecord {
    const plan = this.#plans.get(ownerUserId);
    if (plan === undefined) {
      throw new Error("The user has begun no ChatGPT sign-in.");
    }
    return plan;
  }

  #seal(ownerUserId: string, signIn: PlanSignIn): StoredSignIn {
    const { tokens, ...rest } = signIn;
    return { ...rest, sealedTokens: sealPlanTokens(this.#keyring, ownerUserId, tokens) };
  }

  #open(ownerUserId: string): PlanSignIn | undefined {
    const stored = this.#signIns.get(ownerUserId);
    if (stored === undefined) {
      return undefined;
    }
    const { sealedTokens, ...rest } = stored;
    return { ...rest, tokens: openPlanTokens(this.#keyring, ownerUserId, sealedTokens) };
  }
}
