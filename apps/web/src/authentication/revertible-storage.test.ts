import { describe, expect, it } from "vitest";
import { RevertibleStorage } from "./revertible-storage";

function storageHolding(items: Record<string, string>): RevertibleStorage {
  const storage = new RevertibleStorage();
  for (const [key, value] of Object.entries(items)) {
    storage.setItem(key, value);
  }
  return storage;
}

describe("the sign-in storage", () => {
  it("puts back every item a change set or removed, when its outcome is not kept", async () => {
    const storage = storageHolding({ verifier: "earlier", index: "[1]" });

    await storage.revertUnless(
      async () => {
        storage.setItem("verifier", "refused");
        storage.setItem("slot-2", "refused");
        storage.removeItem("slot-2");
        storage.removeItem("verifier");
        storage.removeItem("index");
        return "refused";
      },
      (outcome) => outcome === "sent",
    );

    expect(storage.getItem("verifier")).toBe("earlier");
    expect(storage.getItem("index")).toBe("[1]");
    expect(storage.getItem("slot-2")).toBeNull();
  });

  it("keeps a change whose outcome is kept", async () => {
    const storage = storageHolding({ verifier: "earlier" });

    await storage.revertUnless(
      async () => {
        storage.setItem("verifier", "newer");
        return "sent";
      },
      (outcome) => outcome === "sent",
    );

    expect(storage.getItem("verifier")).toBe("newer");
  });

  it("puts back a change that threw", async () => {
    const storage = storageHolding({ verifier: "earlier" });

    await expect(
      storage.revertUnless(
        async () => {
          storage.setItem("verifier", "half-done");
          throw new Error("No answer");
        },
        () => true,
      ),
    ).rejects.toThrow("No answer");

    expect(storage.getItem("verifier")).toBe("earlier");
  });
});
