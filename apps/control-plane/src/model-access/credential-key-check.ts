import type { Logger } from "../logger.js";
import type { CredentialKeyring } from "./credential-keyring.js";
import type { ModelCredentialStore } from "./model-credential-store.js";

/**
 * Run at startup, before the control plane listens: every stored credential
 * must be sealed under a key it was given. If any is not, it refuses to
 * start, naming how many and under which key's fingerprint: the usual cause
 * is a missing or mistyped key in the configuration, and starting anyway
 * would leave every thread of those users unable to run, quietly. Then any
 * credential a previous key sealed is sealed again under the current one,
 * after which the previous key can be removed.
 */
export async function checkCredentialKeys(
  store: ModelCredentialStore,
  keyring: CredentialKeyring,
  logger: Logger,
): Promise<void> {
  const counts = await store.countByKeyFingerprint();
  const unreadable = [...counts].filter(([fingerprint]) => !keyring.holdsKey(fingerprint));
  if (unreadable.length > 0) {
    throw new UnreadableCredentialsError(unreadable, keyring.currentFingerprint);
  }
  const resealedCount = await store.sealAgainUnderCurrentKey();
  logger.info(
    {
      credentialCount: [...counts.values()].reduce((total, count) => total + count, 0),
      currentKeyFingerprint: keyring.currentFingerprint,
      resealedCount,
    },
    resealedCount === 0
      ? "Every stored model credential is sealed under the current key"
      : "Sealed stored model credentials again under the current key; the previous keys are no longer needed",
  );
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
