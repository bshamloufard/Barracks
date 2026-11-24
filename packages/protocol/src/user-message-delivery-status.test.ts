import { describe, expect, it } from "vitest";
import { parseControlPlaneToClientMessage } from "./client-messages.js";

describe("the user message delivery status sent to clients", () => {
  it.each([0, 1, 42])("carries delivered through sequence %d unchanged", (sequence) => {
    const message = { type: "user_message_delivery_status", deliveredThroughSequence: sequence };

    expect(parseControlPlaneToClientMessage(JSON.stringify(message))).toEqual({
      ok: true,
      value: message,
    });
  });

  it.each([-1, 2.5])("rejects delivered through sequence %d", (sequence) => {
    const result = parseControlPlaneToClientMessage(
      JSON.stringify({ type: "user_message_delivery_status", deliveredThroughSequence: sequence }),
    );

    expect(result).toEqual({
      ok: false,
      errorMessage: expect.stringContaining("deliveredThroughSequence"),
    });
  });
});
