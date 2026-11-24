import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfiguration } from "./configuration.js";

const sharedVariables = {
  BARRACK_CONTROL_PLANE_URL: "ws://127.0.0.1:8787/",
  BARRACK_THREAD_ID: "thread-1",
  BARRACK_SUPERVISOR_TOKEN: "secret-token-value",
  BARRACK_SUPERVISOR_STATE_DIRECTORY: "/var/lib/barrack/supervisor",
};

describe("readConfiguration", () => {
  it("reads a fake-harness configuration that needs no model or directories", () => {
    const result = readConfiguration({ ...sharedVariables, BARRACK_AGENT_HARNESS: "fake" });

    expect(result).toEqual({
      ok: true,
      configuration: {
        controlPlaneUrl: "ws://127.0.0.1:8787",
        threadId: "thread-1",
        supervisorToken: "secret-token-value",
        supervisorStateDirectory: "/var/lib/barrack/supervisor",
        logLevel: "info",
        agentHarness: { kind: "fake" },
      },
    });
  });

  it("uses the Pi harness by default and resolves its directories to absolute paths", () => {
    const result = readConfiguration({
      ...sharedVariables,
      BARRACK_MODEL: "openai/example-model",
      BARRACK_WORKSPACE_DIRECTORY: "workspace",
      BARRACK_STATE_DIRECTORY: "/var/barrack",
    });

    expect(result).toMatchObject({
      ok: true,
      configuration: {
        agentHarness: {
          kind: "pi",
          model: "openai/example-model",
          workspaceDirectory: path.resolve("workspace"),
          stateDirectory: "/var/barrack",
        },
      },
    });
  });

  it("reads the user Pi should run as, and leaves it unset when not given", () => {
    const piVariables = {
      ...sharedVariables,
      BARRACK_MODEL: "openai/example-model",
      BARRACK_WORKSPACE_DIRECTORY: "/workspace",
      BARRACK_STATE_DIRECTORY: "/var/barrack",
    };

    expect(
      readConfiguration({ ...piVariables, BARRACK_AGENT_USER: "barrack-agent" }),
    ).toMatchObject({
      ok: true,
      configuration: { agentHarness: { agentUserName: "barrack-agent" } },
    });
    expect(readConfiguration(piVariables)).toMatchObject({
      ok: true,
      configuration: { agentHarness: { agentUserName: undefined } },
    });
  });

  it("rejects an agent user that cannot be a user name", () => {
    const result = readConfiguration({
      ...sharedVariables,
      BARRACK_MODEL: "openai/example-model",
      BARRACK_WORKSPACE_DIRECTORY: "/workspace",
      BARRACK_STATE_DIRECTORY: "/var/barrack",
      BARRACK_AGENT_USER: "--reuid=0",
    });

    expect(result).toEqual({
      ok: false,
      problems: ["BARRACK_AGENT_USER: must be the name of an operating-system user"],
    });
  });

  it("lists every missing variable the Pi harness needs", () => {
    const result = readConfiguration({ ...sharedVariables, BARRACK_AGENT_HARNESS: "pi" });

    expect(result).toEqual({
      ok: false,
      problems: [
        "BARRACK_MODEL: is required",
        "BARRACK_WORKSPACE_DIRECTORY: is required",
        "BARRACK_STATE_DIRECTORY: is required",
      ],
    });
  });

  it("requires the supervisor's own state directory, whichever harness runs", () => {
    const { BARRACK_SUPERVISOR_STATE_DIRECTORY: _, ...withoutStateDirectory } = sharedVariables;

    const result = readConfiguration({ ...withoutStateDirectory, BARRACK_AGENT_HARNESS: "fake" });

    expect(result).toEqual({
      ok: false,
      problems: ["BARRACK_SUPERVISOR_STATE_DIRECTORY: is required"],
    });
  });

  it("rejects a control plane URL that is not a WebSocket URL", () => {
    const result = readConfiguration({
      ...sharedVariables,
      BARRACK_AGENT_HARNESS: "fake",
      BARRACK_CONTROL_PLANE_URL: "http://127.0.0.1:8787",
    });

    expect(result).toEqual({
      ok: false,
      problems: ["BARRACK_CONTROL_PLANE_URL: must be a ws:// or wss:// URL"],
    });
  });

  it("names an unknown harness", () => {
    const result = readConfiguration({ ...sharedVariables, BARRACK_AGENT_HARNESS: "codex" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems).toContain(
      'BARRACK_AGENT_HARNESS: must be "pi" or "fake", got "codex"',
    );
  });

  it("never repeats a variable's value in its problems", () => {
    const result = readConfiguration({
      BARRACK_SUPERVISOR_TOKEN: "x",
      BARRACK_MODEL: "not a model",
    });

    expect(JSON.stringify(result)).not.toContain("not a model");
  });
});
