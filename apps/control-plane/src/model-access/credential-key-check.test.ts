import { randomBytes } from "node:crypto";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { checkCredentialKeys, UnreadableCredentialsError } from "./credential-key-check.js";
import { CredentialKeyring } from "./credential-keyring.js";
import { InMemoryModelCredentialStore } from "./in-memory-model-credential-store.js";
import type { SealedModelCredentialRow } from "./model-credential-store.js";

const logger = pino({ level: "silent" });

async function storeOneCredentialUnder(
  key: Buffer,
): Promise<Map<string, SealedModelCredentialRow>> {
  const rows = new Map<string, SealedModelCredentialRow>();
  await new InMemoryModelCredentialStore(new CredentialKeyring(key), rows).save({
    ownerUserId: "user-a",
    providerId: "anthropic",
    secret: "sk-test-0123456789",
    settings: {},
    addedAt: new Date(),
  });
  return rows;
}

describe("checking the credential keys at startup", () => {
  it("refuses to start when a stored credential was sealed under a key it was not given, naming its fingerprint", async () => {
    const sealingKeyring = new CredentialKeyring(randomBytes(32));
    const rows = await storeOneCredentialUnder(randomBytes(32));
    const otherKey = randomBytes(32);
    const rowsUnderOther = await storeOneCredentialUnder(otherKey);
    const fingerprint = new CredentialKeyring(otherKey).currentFingerprint;

    const check = checkCredentialKeys(
      new InMemoryModelCredentialStore(sealingKeyring, rowsUnderOther),
      sealingKeyring,
      logger,
    );

    await expect(check).rejects.toBeInstanceOf(UnreadableCredentialsError);
    await expect(check).rejects.toThrow(`1 under the key with fingerprint ${fingerprint}`);
    expect(rows.size).toBe(1);
  });

  it("starts with no stored credential, whatever the key", async () => {
    const keyring = new CredentialKeyring(randomBytes(32));

    await expect(
      checkCredentialKeys(new InMemoryModelCredentialStore(keyring), keyring, logger),
    ).resolves.toBeUndefined();
  });

  it("seals what a previous key sealed again under the current one", async () => {
    const previousKey = randomBytes(32);
    const rows = await storeOneCredentialUnder(previousKey);
    const keyring = new CredentialKeyring(randomBytes(32), [previousKey]);

    await checkCredentialKeys(new InMemoryModelCredentialStore(keyring, rows), keyring, logger);

    expect([...rows.values()].map((row) => row.sealed.keyFingerprint)).toEqual([
      keyring.currentFingerprint,
    ]);
  });
});
