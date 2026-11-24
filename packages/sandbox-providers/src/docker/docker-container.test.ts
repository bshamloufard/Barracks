import { describe, expect, it } from "vitest";
import {
  hasSupervisorFailed,
  type InspectedContainer,
  parseInspectedContainer,
  summariseLastWords,
  toSandboxStatus,
} from "./docker-container.js";

function containerWith(state: Partial<InspectedContainer["State"]>): InspectedContainer {
  return {
    Id: "a".repeat(64),
    State: { Status: "running", ExitCode: 0, OOMKilled: false, Error: "", ...state },
    Config: { Labels: { "barrack.sandbox": "true" } },
  };
}

describe("reading a Docker container's state as a sandbox's", () => {
  it("treats a running container as a running sandbox", () => {
    expect(toSandboxStatus(containerWith({ Status: "running" }))).toEqual({ state: "running" });
  });

  it("treats a container whose supervisor stopped when asked as stopped", () => {
    for (const exitCode of [0, 137, 143]) {
      expect(toSandboxStatus(containerWith({ Status: "exited", ExitCode: exitCode }))).toEqual({
        state: "stopped",
      });
    }
  });

  it("treats a container whose supervisor exited with an error as failed, saying how", () => {
    expect(toSandboxStatus(containerWith({ Status: "exited", ExitCode: 1 }))).toEqual({
      state: "failed",
      cause: "supervisor-exited",
      reason: "the supervisor exited with code 1",
    });
  });

  it("tells a supervisor that refused to start from one that failed later, in its own words", () => {
    const container = containerWith({ Status: "exited", ExitCode: 78 });

    expect(hasSupervisorFailed(container)).toBe(true);
    expect(toSandboxStatus(container, "BARRACK_THREAD_ID: is required")).toEqual({
      state: "failed",
      cause: "supervisor-refused-to-start",
      reason: "the supervisor refused to start, saying: BARRACK_THREAD_ID: is required",
    });
  });

  it("recognises a supervisor that stopped because the disk was full", () => {
    const container = containerWith({ Status: "exited", ExitCode: 1 });

    expect(toSandboxStatus(container, "Error: ENOSPC: no space left on device")).toMatchObject({
      state: "failed",
      cause: "out-of-disk",
    });
  });

  it("treats a container killed for running out of memory as failed", () => {
    expect(
      toSandboxStatus(containerWith({ Status: "exited", ExitCode: 137, OOMKilled: true })),
    ).toEqual({ state: "failed", cause: "out-of-memory", reason: "the sandbox ran out of memory" });
  });

  it("keeps the last few lines of what the supervisor wrote to standard error, cut short", () => {
    const standardError = [
      "an older run's line",
      ...Array.from({ length: 6 }, (_, index) => `line ${index}`),
      "",
    ].join("\n");

    expect(summariseLastWords(standardError)).toBe("line 0 line 1 line 2 line 3 line 4 line 5");
    expect(summariseLastWords("x".repeat(1000))?.length).toBe(600);
    expect(summariseLastWords("\n\n")).toBeUndefined();
  });

  it("treats a container that was created but never started as stopped", () => {
    expect(toSandboxStatus(containerWith({ Status: "created" }))).toEqual({ state: "stopped" });
  });

  it("treats a paused or dead container as failed", () => {
    expect(toSandboxStatus(containerWith({ Status: "dead", Error: "disk gone" }))).toEqual({
      state: "failed",
      cause: "provider-fault",
      reason: "the container is dead: disk gone",
    });
    expect(toSandboxStatus(containerWith({ Status: "paused" }))).toMatchObject({
      state: "failed",
    });
  });

  it("rejects inspect output that is missing what Barrack reads", () => {
    expect(() => parseInspectedContainer('{"Id":"abc"}')).toThrow();
  });
});
