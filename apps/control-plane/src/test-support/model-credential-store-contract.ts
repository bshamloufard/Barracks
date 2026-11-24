import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type CredentialBinding,
  CredentialKeyring,
  UnreadableCredentialError,
} from "../model-access/credential-keyring.js";
import type {
  ModelCredentialStore,
  NewModelCredential,
} from "../model-access/model-credential-store.js";

/** The users whose credentials the contract stores; a store that checks owners must have them recorded. */
export const credentialContractOwnerUserIds = ["user-a", "user-b"] as const;

const [ownerA, ownerB] = credentialContractOwnerUserIds;

/**
 * Stores over one storage, each sealing with the keyring it is given, so the
 * contract can see what a control plane with another key makes of what is
 * stored; and two ways of meddling with what is stored, as someone with the
 * database alone could.
 */
export type CredentialStoreTestBed = {
  storeWith(keyring: CredentialKeyring): ModelCredentialStore;
  /** Changes one byte of the stored, sealed credential. */
  tamperWith(binding: CredentialBinding): Promise<void>;
  /** Copies one row's sealed credential over another row's, which must exist. */
  copySealed(from: CredentialBinding, to: CredentialBinding): Promise<void>;
};

const addedAt = new Date("2026-11-24T09:00:00.000Z");

function credentialOf(
  ownerUserId: string,
  providerId: string,
  secret: string,
  settings: Record<string, string> = {},
): NewModelCredential {
  return { ownerUserId, providerId, secret, settings, addedAt };
}

function createKeyring(previous: readonly Buffer[] = []): CredentialKeyring {
  return new CredentialKeyring(randomBytes(32), previous);
}

/**
 * The behaviour every `ModelCredentialStore` must have, the in-memory one
 * and the Postgres one alike.
 */
export function describeModelCredentialStoreContract(
  implementationName: string,
  createTestBed: () => Promise<CredentialStoreTestBed>,
): void {
  describe(`${implementationName} (model credential store contract)`, () => {
    it("opens what it sealed, and shows only the provider, when, and the key's last four characters", async () => {
      const store = (await createTestBed()).storeWith(createKeyring());
      await store.save(
        credentialOf(ownerA, "cloudflare-workers-ai", "cf-key-0123456789", {
          CLOUDFLARE_ACCOUNT_ID: "account-1",
        }),
      );

      expect(await store.read(ownerA, "cloudflare-workers-ai")).toEqual({
        secret: "cf-key-0123456789",
        settings: { CLOUDFLARE_ACCOUNT_ID: "account-1" },
      });
      expect(await store.list(ownerA)).toEqual([
        { providerId: "cloudflare-workers-ai", addedAt, secretEnding: "6789" },
      ]);
      expect(await store.has(ownerA, "cloudflare-workers-ai")).toBe(true);
    });

    it("replaces a user's key for a provider, keeping one", async () => {
      const store = (await createTestBed()).storeWith(createKeyring());
      await store.save(credentialOf(ownerA, "anthropic", "first-key-aaaa"));

      const laterAddedAt = new Date("2026-11-24T10:00:00.000Z");
      await store.save({
        ...credentialOf(ownerA, "anthropic", "second-key-bbbb"),
        addedAt: laterAddedAt,
      });

      expect(await store.read(ownerA, "anthropic")).toEqual({
        secret: "second-key-bbbb",
        settings: {},
      });
      expect(await store.list(ownerA)).toEqual([
        { providerId: "anthropic", addedAt: laterAddedAt, secretEnding: "bbbb" },
      ]);
    });

    it("removes a key, after which there is none to read or remove", async () => {
      const store = (await createTestBed()).storeWith(createKeyring());
      await store.save(credentialOf(ownerA, "anthropic", "first-key-aaaa"));

      expect(await store.remove(ownerA, "anthropic")).toBe(true);

      expect(await store.read(ownerA, "anthropic")).toBeUndefined();
      expect(await store.has(ownerA, "anthropic")).toBe(false);
      expect(await store.list(ownerA)).toEqual([]);
      expect(await store.remove(ownerA, "anthropic")).toBe(false);
    });

    it("keeps each user's keys to that user", async () => {
      const store = (await createTestBed()).storeWith(createKeyring());
      await store.save(credentialOf(ownerA, "anthropic", "key-of-user-a"));
      await store.save(credentialOf(ownerB, "openai", "key-of-user-b"));

      expect(await store.list(ownerB)).toEqual([
        { providerId: "openai", addedAt, secretEnding: "er-b" },
      ]);
      expect(await store.has(ownerB, "anthropic")).toBe(false);
      expect(await store.read(ownerB, "anthropic")).toBeUndefined();
      expect(await store.remove(ownerB, "anthropic")).toBe(false);
      expect(await store.read(ownerA, "anthropic")).toEqual({
        secret: "key-of-user-a",
        settings: {},
      });
    });

    it("refuses to open a key sealed under another encryption key, and says which key sealed it", async () => {
      const testBed = await createTestBed();
      const firstKeyring = createKeyring();
      await testBed.storeWith(firstKeyring).save(credentialOf(ownerA, "anthropic", "sealed-key-1"));

      const otherStore = testBed.storeWith(createKeyring());

      await expect(otherStore.read(ownerA, "anthropic")).rejects.toMatchObject({
        name: "UnreadableCredentialError",
        reason: "unknown_key",
      });
      expect(await otherStore.countByKeyFingerprint()).toEqual(
        new Map([[firstKeyring.currentFingerprint, 1]]),
      );
      expect(await otherStore.list(ownerA)).toHaveLength(1);
    });

    it("opens a key sealed under a previous encryption key, and seals it again under the current one", async () => {
      const testBed = await createTestBed();
      const previousKey = randomBytes(32);
      await testBed
        .storeWith(new CredentialKeyring(previousKey))
        .save(credentialOf(ownerA, "anthropic", "sealed-key-1"));
      const currentKey = randomBytes(32);
      const rotatingStore = testBed.storeWith(new CredentialKeyring(currentKey, [previousKey]));

      expect(await rotatingStore.read(ownerA, "anthropic")).toMatchObject({
        secret: "sealed-key-1",
      });
      expect(await rotatingStore.sealAgainUnderCurrentKey()).toEqual({
        resealedCount: 1,
        unreadableCount: 0,
      });
      expect(await rotatingStore.sealAgainUnderCurrentKey()).toEqual({
        resealedCount: 0,
        unreadableCount: 0,
      });

      const currentOnlyStore = testBed.storeWith(new CredentialKeyring(currentKey));
      expect(await currentOnlyStore.read(ownerA, "anthropic")).toMatchObject({
        secret: "sealed-key-1",
      });
    });

    it("seals again what it can open and leaves, counted, what was sealed under a key it was not given", async () => {
      const testBed = await createTestBed();
      const previousKey = randomBytes(32);
      await testBed
        .storeWith(new CredentialKeyring(previousKey))
        .save(credentialOf(ownerA, "anthropic", "sealed-key-1"));
      await testBed.storeWith(createKeyring()).save(credentialOf(ownerA, "openai", "sealed-key-2"));
      const currentKeyring = new CredentialKeyring(randomBytes(32), [previousKey]);
      const rotatingStore = testBed.storeWith(currentKeyring);

      const outcome = await rotatingStore.sealAgainUnderCurrentKey();

      expect(outcome).toEqual({ resealedCount: 1, unreadableCount: 1 });
      expect(await rotatingStore.read(ownerA, "anthropic")).toMatchObject({
        secret: "sealed-key-1",
      });
      expect(
        (await rotatingStore.countByKeyFingerprint()).get(currentKeyring.currentFingerprint),
      ).toBe(1);
    });

    it("refuses to open a sealed key that was altered", async () => {
      const testBed = await createTestBed();
      const store = testBed.storeWith(createKeyring());
      await store.save(credentialOf(ownerA, "anthropic", "sealed-key-1"));

      await testBed.tamperWith({ ownerUserId: ownerA, providerId: "anthropic" });

      await expect(store.read(ownerA, "anthropic")).rejects.toBeInstanceOf(
        UnreadableCredentialError,
      );
      await expect(store.read(ownerA, "anthropic")).rejects.toMatchObject({
        reason: "not_authentic",
      });
    });

    it("refuses to open a sealed key moved to another user's row, or another provider's", async () => {
      const testBed = await createTestBed();
      const store = testBed.storeWith(createKeyring());
      await store.save(credentialOf(ownerA, "anthropic", "key-of-user-a"));
      await store.save(credentialOf(ownerB, "anthropic", "key-of-user-b"));
      await store.save(credentialOf(ownerA, "openai", "other-key-of-user-a"));

      await testBed.copySealed(
        { ownerUserId: ownerA, providerId: "anthropic" },
        { ownerUserId: ownerB, providerId: "anthropic" },
      );
      await testBed.copySealed(
        { ownerUserId: ownerA, providerId: "anthropic" },
        { ownerUserId: ownerA, providerId: "openai" },
      );

      await expect(store.read(ownerB, "anthropic")).rejects.toMatchObject({
        reason: "not_authentic",
      });
      await expect(store.read(ownerA, "openai")).rejects.toMatchObject({
        reason: "not_authentic",
      });
      expect(await store.read(ownerA, "anthropic")).toMatchObject({ secret: "key-of-user-a" });
    });
  });
}
