import { describe, expect, it } from "vitest";
import { buildPiEnvironment } from "./pi-environment.js";

describe("buildPiEnvironment", () => {
  const sourceEnvironment = {
    PATH: "/usr/bin",
    HOME: "/home/agent",
    ANTHROPIC_API_KEY: "provider-key",
    BARRACK_SUPERVISOR_TOKEN: "control-plane-token",
    AWS_SECRET_ACCESS_KEY: "cloud-secret",
    GITHUB_TOKEN: "repository-token",
    PI_OFFLINE: "1",
  };

  it("passes basic variables and Pi's own settings, and no model provider key", () => {
    const environment = buildPiEnvironment(sourceEnvironment, "/state/pi/agent");

    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/agent",
      PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: "/state/pi/agent",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    });
  });

  it("never passes the supervisor's control plane token", () => {
    const environment = buildPiEnvironment(sourceEnvironment, "/state/pi/agent");

    expect(Object.values(environment)).not.toContain("control-plane-token");
  });

  it("keeps Pi's agent directory under the supervisor's state even when the source names another", () => {
    const environment = buildPiEnvironment(
      { PI_CODING_AGENT_DIR: "/somewhere/else" },
      "/state/pi/agent",
    );

    expect(environment).toMatchObject({ PI_CODING_AGENT_DIR: "/state/pi/agent" });
  });
});
