import { describe, expect, it } from "vitest";
import type { UserStore } from "../users/user-store.js";

/** The behaviour every `UserStore` must have, as the thread store contract does for threads. */
export function describeUserStoreContract(
  implementationName: string,
  createEmptyStore: () => Promise<UserStore>,
): void {
  describe(`${implementationName} as a user store`, () => {
    it("knows a user only once they are recorded", async () => {
      const store = await createEmptyStore();

      expect(await store.hasUser("user-a")).toBe(false);
      await store.recordUser("user-a", undefined);

      expect(await store.hasUser("user-a")).toBe(true);
      expect(await store.hasUser("user-b")).toBe(false);
    });

    it("records a user again without complaint, however many times at once", async () => {
      const store = await createEmptyStore();

      await Promise.all(Array.from({ length: 10 }, () => store.recordUser("user-a", undefined)));
      await store.recordUser("user-a", undefined);

      expect(await store.hasUser("user-a")).toBe(true);
    });

    it("keeps the digest of the user's confirmed email address as last recorded", async () => {
      const store = await createEmptyStore();
      const first = Buffer.alloc(32, 1);
      const second = Buffer.alloc(32, 2);

      expect(await store.readConfirmedEmailDigest("user-a")).toBeUndefined();
      await store.recordUser("user-a", first);
      expect(await store.readConfirmedEmailDigest("user-a")).toEqual(first);
      await store.recordUser("user-a", second);
      expect(await store.readConfirmedEmailDigest("user-a")).toEqual(second);
      await store.recordUser("user-a", undefined);
      expect(await store.readConfirmedEmailDigest("user-a")).toBeUndefined();
    });
  });
}
