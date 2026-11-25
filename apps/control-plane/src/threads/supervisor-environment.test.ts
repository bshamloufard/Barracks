import { describe, expect, it } from "vitest";
import { readPiSettings } from "./pi-settings.js";
import { buildSupervisorEnvironment } from "./supervisor-environment.js";

const developerEnvironment = {
  ANTHROPIC_API_KEY: "developer-key",
  AWS_SECRET_ACCESS_KEY: "cloud-credentials",
  DATABASE_URL: "postgres://user:password@db/barrack",
  PI_CACHE_RETENTION: "long",
  PI_OFFLINE: "1",
  PI_SESSION_FILE: "/home/developer/.pi/agent/sessions/one.jsonl",
};

describe("a new sandbox's supervisor environment", () => {
  it("tells a Pi supervisor its thread and the forwarded Pi settings, hands it its token as a secret, and no model or key", () => {
    const { supervisorEnvironment, supervisorSecrets } = buildSupervisorEnvironment(
      {
        controlPlaneUrlForSandboxes: "wss://barrack.example",
        agent: { harness: "pi" },
        piSettings: readPiSettings(developerEnvironment),
      },
      "thread-1",
      "token-1",
    );

    expect(supervisorEnvironment).toEqual({
      PI_CACHE_RETENTION: "long",
      BARRACK_CONTROL_PLANE_URL: "wss://barrack.example",
      BARRACK_THREAD_ID: "thread-1",
      BARRACK_AGENT_HARNESS: "pi",
    });
    expect(supervisorSecrets).toEqual({ BARRACK_SUPERVISOR_TOKEN: "token-1" });
  });

  it("gives a fake agent's supervisor no Pi settings", () => {
    const { supervisorEnvironment: environment } = buildSupervisorEnvironment(
      {
        controlPlaneUrlForSandboxes: "ws://127.0.0.1:8787",
        agent: { harness: "fake" },
        piSettings: readPiSettings(developerEnvironment),
      },
      "thread-1",
      "token-1",
    );

    expect(environment).not.toHaveProperty("PI_CACHE_RETENTION");
    expect(environment).toMatchObject({ BARRACK_AGENT_HARNESS: "fake" });
  });
});
