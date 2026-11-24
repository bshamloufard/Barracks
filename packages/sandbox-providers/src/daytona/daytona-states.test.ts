import { describe, expect, it } from "vitest";
import type { DaytonaSandboxRecord } from "./daytona-api.js";
import { toSandboxStatus } from "./daytona-states.js";

function sandboxIn(state: string | undefined, errorReason?: string): DaytonaSandboxRecord {
  return { id: "daytona-1", state, errorReason, labels: {}, environment: undefined };
}

describe("reading a Daytona sandbox's state as Barrack's", () => {
  it.each([
    ["started", "running"],
    ["creating", "starting"],
    ["starting", "starting"],
    ["restoring", "starting"],
    ["pulling_snapshot", "starting"],
    ["stopping", "stopping"],
    ["archiving", "stopping"],
    ["destroying", "stopping"],
    ["stopped", "stopped"],
    ["archived", "stopped"],
    ["destroyed", "missing"],
  ])("reads %s as %s", (daytonaState, barrackState) => {
    expect(toSandboxStatus(sandboxIn(daytonaState))).toEqual({ state: barrackState });
  });

  it("reads a sandbox Daytona does not have as missing", () => {
    expect(toSandboxStatus(undefined)).toEqual({ state: "missing" });
  });

  it("reads Daytona's error states as failed, with Daytona's reason", () => {
    expect(toSandboxStatus(sandboxIn("error", "runner lost"))).toEqual({
      state: "failed",
      cause: "provider-fault",
      reason: "runner lost",
    });
    expect(toSandboxStatus(sandboxIn("build_failed"))).toEqual({
      state: "failed",
      cause: "provider-fault",
      reason: "Daytona reports build_failed",
    });
  });

  it("reads a state Barrack never asks for as failed, naming it", () => {
    expect(toSandboxStatus(sandboxIn("paused"))).toEqual({
      state: "failed",
      cause: "provider-fault",
      reason: 'Daytona reports the unexpected state "paused"',
    });
    expect(toSandboxStatus(sandboxIn(undefined))).toMatchObject({ state: "failed" });
  });
});
