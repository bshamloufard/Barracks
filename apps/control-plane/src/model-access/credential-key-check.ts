import type { Logger } from "../logger.js";
import type { CredentialKeyring } from "./credential-keyring.js";
import type { ModelCredentialStore, ResealingOutcome } from "./model-credential-store.js";

/**
 * What the check and resealing need of a store of things sealed under the
 * configured key: users' model keys, and their ChatGPT plans' sign-ins.
 */
export type SealedCredentialStore = Pick<
  ModelCredentialStore,
  "countByKeyFingerprint" | "sealAgainUnderCurrentKey"
>;

/** Several stores checked and resealed as one, their counts added up. */
export function combineSealedStores(
  stores: readonly SealedCredentialStore[],
): SealedCredentialStore {
  return {
    async countByKeyFingerprint() {
      const counts = new Map<string, number>();
      for (const store of stores) {
        for (const [fingerprint, count] of await store.countByKeyFingerprint()) {
          counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + count);
        }
      }
      return counts;
    },
    async sealAgainUnderCurrentKey() {
      const total: ResealingOutcome = { resealedCount: 0, unreadableCount: 0 };
      for (const store of stores) {
        const outcome = await store.sealAgainUnderCurrentKey();
        total.resealedCount += outcome.resealedCount;
        total.unreadableCount += outcome.unreadableCount;
      }
      return total;
    },
  };
}

/**
 * Run at startup, before the control plane listens: every stored credential
 * must be sealed under a key it was given. If any is not, it refuses to
 * start, naming how many and under which key's fingerprint: the usual cause
 * is a missing or mistyped key in the configuration, and starting anyway
 * would leave every thread of those users unable to run, quietly. Then any
 * credential a previous key sealed is sealed again under the current one.
 */
export async function checkCredentialKeys(
  store: SealedCredentialStore,
  keyring: CredentialKeyring,
  logger: Logger,
): Promise<void> {
  const counts = await store.countByKeyFingerprint();
  const unreadable = [...counts].filter(([fingerprint]) => !keyring.holdsKey(fingerprint));
  if (unreadable.length > 0) {
    throw new UnreadableCredentialsError(unreadable, keyring.currentFingerprint);
  }
  await sealStoredCredentialsAgain(store, keyring, logger);
}

/**
 * Seals again under the current key whatever a previous key sealed, and
 * says in the log whether anything is left under another key. Run at
 * startup and then every few minutes (`CredentialResealing`): during a
 * redeploy's overlap the instance being replaced, which holds only the old
 * key, seals under it any key a user saves through it, after this one's
 * startup has run; those are resealed on a later pass. The previous key may
 * be removed from the configuration once a pass has logged that every key
 * is under the current one, after the old instance has gone.
 */
export async function sealStoredCredentialsAgain(
  store: SealedCredentialStore,
  keyring: CredentialKeyring,
  logger: Logger,
): Promise<void> {
  const { resealedCount, unreadableCount } = await store.sealAgainUnderCurrentKey();
  const context = { currentKeyFingerprint: keyring.currentFingerprint, resealedCount };
  if (unreadableCount > 0) {
    logger.error(
      { ...context, unreadableCount },
      "Some stored model credentials are sealed under a key this control plane was not given, or were altered; they are left as they are",
    );
    return;
  }
  if (resealedCount > 0) {
    logger.info(context, "Sealed stored model credentials again under the current key");
  }
  logger.info(
    context,
    "Every stored model credential is sealed under the current key; previous keys are no longer needed",
  );
}

/** How often stored credentials are sealed again, to pick up any sealed under an old key since. */
export const resealingIntervalInMilliseconds = 5 * 60_000;

/** Seals stored credentials again every few minutes; see `sealStoredCredentialsAgain`. */
export class CredentialResealing {
  readonly #store: SealedCredentialStore;
  readonly #keyring: CredentialKeyring;
  readonly #logger: Logger;
  #timer: NodeJS.Timeout | undefined;

  constructor(store: SealedCredentialStore, keyring: CredentialKeyring, logger: Logger) {
    this.#store = store;
    this.#keyring = keyring;
    this.#logger = logger;
  }

  start(intervalInMilliseconds = resealingIntervalInMilliseconds): void {
    this.#timer = setInterval(() => {
      sealStoredCredentialsAgain(this.#store, this.#keyring, this.#logger).catch((error: unknown) =>
        this.#logger.error({ err: error }, "Could not seal stored model credentials again"),
      );
    }, intervalInMilliseconds);
  }

  stop(): void {
    clearInterval(this.#timer);
  }
}

export class UnreadableCredentialsError extends Error {
  constructor(unreadable: Array<[string, number]>, currentFingerprint: string) {
    const described = unreadable
      .map(([fingerprint, count]) => `${count} under the key with fingerprint ${fingerprint}`)
      .join(", ");
    super(
      `Stored model credentials were sealed under keys this control plane was not given: ${described}. ` +
        `BARRACK_MODEL_CREDENTIAL_KEY has fingerprint ${currentFingerprint}. ` +
        "Set the key they were sealed under, as BARRACK_MODEL_CREDENTIAL_KEY or among BARRACK_MODEL_CREDENTIAL_PREVIOUS_KEYS. " +
        "If that key is lost, so are those credentials: delete their rows from barrack.model_credentials, and their owners add their keys again (see docs/deployment.md).",
    );
    this.name = "UnreadableCredentialsError";
  }
}
