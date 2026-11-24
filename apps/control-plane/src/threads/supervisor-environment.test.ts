import { describe, expect, it } from "vitest";
import { readModelCredentials } from "./model-credentials.js";
import { buildSupervisorEnvironment } from "./supervisor-environment.js";

const developerEnvironment = {
  ANTHROPIC_API_KEY: "developer-key",
  AWS_SECRET_ACCESS_KEY: "cloud-credentials",
  DATABASE_URL: "postgres://user:password@db/barrack",
};

describe("a new sandbox's supervisor environment", () => {
  it("tells a Pi supervisor its thread, token, model and the forwarded model keys, and nothing else of the control plane's", () => {
    const environment = buildSupervisorEnvironment(
      {
        controlPlaneUrlForSandboxes: "wss://barrack.example",
        agent: { harness: "pi", model: "anthropic/example-model" },
        modelCredentials: readModelCredentials(developerEnvironment),
      },
      "thread-1",
      "token-1",
    );

    expect(environment).toEqual({
      ANTHROPIC_API_KEY: "developer-key",
      BARRACK_CONTROL_PLANE_URL: "wss://barrack.example",
      BARRACK_THREAD_ID: "thread-1",
      BARRACK_SUPERVISOR_TOKEN: "token-1",
      BARRACK_AGENT_HARNESS: "pi",
      BARRACK_MODEL: "anthropic/example-model",
    });
  });

  it("gives a fake agent's supervisor no model keys", () => {
    const environment = buildSupervisorEnvironment(
      {
        controlPlaneUrlForSandboxes: "ws://127.0.0.1:8787",
        agent: { harness: "fake" },
        modelCredentials: readModelCredentials(developerEnvironment),
      },
      "thread-1",
      "token-1",
    );

    expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(environment).toMatchObject({ BARRACK_AGENT_HARNESS: "fake" });
  });
});
