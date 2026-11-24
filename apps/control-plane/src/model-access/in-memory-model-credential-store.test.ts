import { describeModelCredentialStoreContract } from "../test-support/model-credential-store-contract.js";
import { InMemoryModelCredentialStore } from "./in-memory-model-credential-store.js";
import type { SealedModelCredentialRow } from "./model-credential-store.js";

describeModelCredentialStoreContract("InMemoryModelCredentialStore", async () => {
  const rows = new Map<string, SealedModelCredentialRow>();
  const findRow = (ownerUserId: string, providerId: string): SealedModelCredentialRow => {
    const row = rows.get(`${ownerUserId}\0${providerId}`);
    if (row === undefined) {
      throw new Error(`No stored credential of ${ownerUserId} for ${providerId}.`);
    }
    return row;
  };
  return {
    storeWith: (keyring) => new InMemoryModelCredentialStore(keyring, rows),
    tamperWith: async ({ ownerUserId, providerId }) => {
      const { ciphertext } = findRow(ownerUserId, providerId).sealed;
      ciphertext.writeUInt8(ciphertext.readUInt8(0) ^ 0x01, 0);
    },
    copySealed: async (from, to) => {
      findRow(to.ownerUserId, to.providerId).sealed = {
        ...findRow(from.ownerUserId, from.providerId).sealed,
      };
    },
  };
});
