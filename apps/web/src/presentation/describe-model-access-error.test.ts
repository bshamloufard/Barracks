import { modelAccessErrorKindSchema } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import { describeModelAccessError } from "./describe-model-access-error";

describe("describing why the model could not answer", () => {
  it.each(modelAccessErrorKindSchema.options)(
    "says what happened and what to do for %s",
    (kind) => {
      const description = describeModelAccessError(kind);

      expect(description.what).not.toBe("");
      expect(description.nextStep).toMatch(/send your message again/);
    },
  );

  it("sends the user to Settings for a missing or rejected key, and not for quota or rate limits", () => {
    expect(describeModelAccessError("credential_rejected")).toMatchObject({
      nextStep: "Replace the key in Settings, then send your message again.",
      isFixedInSettings: true,
    });
    expect(describeModelAccessError("quota_exhausted").nextStep).toContain("switch this thread");
    expect(describeModelAccessError("rate_limited").isFixedInSettings).toBe(false);
  });
});
