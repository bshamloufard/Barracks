import { describe, expect, it } from "vitest";
import { assistantMessageEventSchema } from "./agent-events.js";
import {
  configureModelAccessSchema,
  credentialSecretSchema,
  modelReferenceSchema,
  parseModelReference,
} from "./model-access.js";
import { parseControlPlaneToSupervisorMessage } from "./supervisor-messages.js";

describe("model references", () => {
  it.each([
    "anthropic/example-model",
    "openrouter/anthropic/example-model",
    "cloudflare-workers-ai/@cf/vendor/model",
    "mock/mock-1",
  ])("accepts %s", (reference) => {
    expect(modelReferenceSchema.safeParse(reference).success).toBe(true);
  });

  it.each([
    "no-provider",
    "/model",
    "anthropic/",
    "Anthropic/model",
    "anthropic/model with spaces",
    "anthropic//model",
  ])("refuses %s", (reference) => {
    expect(modelReferenceSchema.safeParse(reference).success).toBe(false);
  });

  it("splits at the first slash, so the model may contain more", () => {
    expect(parseModelReference("openrouter/anthropic/example-model")).toEqual({
      providerId: "openrouter",
      modelId: "anthropic/example-model",
    });
  });
});

describe("credential secrets", () => {
  it("accepts printable keys and refuses spaces, line breaks and very short ones", () => {
    expect(credentialSecretSchema.safeParse("sk-test-0123456789").success).toBe(true);
    expect(credentialSecretSchema.safeParse("sk-test 0123456789").success).toBe(false);
    expect(credentialSecretSchema.safeParse("sk-test\n0123456789").success).toBe(false);
    expect(credentialSecretSchema.safeParse("short").success).toBe(false);
  });
});

describe("configure_model_access", () => {
  it("carries a model and a credential, or nulls for neither", () => {
    const message = {
      type: "configure_model_access",
      model: "anthropic/example-model",
      credential: { kind: "api_key", secret: "sk-test-0123456789", settings: {} },
    };

    expect(parseControlPlaneToSupervisorMessage(JSON.stringify(message))).toEqual({
      ok: true,
      value: message,
    });
    expect(
      configureModelAccessSchema.safeParse({
        type: "configure_model_access",
        model: null,
        credential: null,
      }).success,
    ).toBe(true);
  });

  it("refuses settings named like anything but environment variables", () => {
    const message = {
      type: "configure_model_access",
      model: "cloudflare-workers-ai/model",
      credential: { kind: "api_key", secret: "key-0123456789", settings: { "account id": "x" } },
    };

    expect(configureModelAccessSchema.safeParse(message).success).toBe(false);
  });
});

describe("an errored assistant message's kind", () => {
  const erroredMessage = {
    type: "assistant_message",
    messageId: "message-1",
    content: [],
    endReason: "errored",
    errorMessage: "429: quota exceeded",
  };

  it("may say why the model could not answer", () => {
    expect(
      assistantMessageEventSchema.safeParse({ ...erroredMessage, errorKind: "quota_exhausted" })
        .success,
    ).toBe(true);
    expect(assistantMessageEventSchema.safeParse(erroredMessage).success).toBe(true);
  });

  it("is refused on a message that did not error", () => {
    const completedMessage = {
      type: "assistant_message",
      messageId: "message-1",
      content: [],
      endReason: "completed",
      errorKind: "rate_limited",
    };

    expect(assistantMessageEventSchema.safeParse(completedMessage).success).toBe(false);
  });
});
