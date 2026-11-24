import { describe, expect, it } from "vitest";
import {
  type InspectedContainer,
  parseInspectedContainer,
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
      reason: "the supervisor exited with code 1",
    });
  });

  it("treats a container killed for running out of memory as failed", () => {
    expect(
      toSandboxStatus(containerWith({ Status: "exited", ExitCode: 137, OOMKilled: true })),
    ).toEqual({ state: "failed", reason: "the sandbox ran out of memory" });
  });

  it("treats a container that was created but never started as stopped", () => {
    expect(toSandboxStatus(containerWith({ Status: "created" }))).toEqual({ state: "stopped" });
  });

  it("treats a paused or dead container as failed", () => {
    expect(toSandboxStatus(containerWith({ Status: "dead", Error: "disk gone" }))).toEqual({
      state: "failed",
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
