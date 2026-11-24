import { userMessageIdSchema } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import { mintUserMessageId } from "./user-message-id";

describe("a user message's identifier", () => {
  it("has the shape the control plane accepts, and is different every time", () => {
    const identifiers = Array.from({ length: 100 }, () => mintUserMessageId());

    for (const identifier of identifiers) {
      expect(userMessageIdSchema.safeParse(identifier).success).toBe(true);
    }
    expect(new Set(identifiers).size).toBe(identifiers.length);
  });
});
