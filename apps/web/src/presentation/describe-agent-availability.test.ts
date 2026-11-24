import type { ThreadSandbox } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import { initialThreadState, type ThreadState } from "../thread-state/thread-state";
import {
  describeAgentAvailability,
  describeWhySendingIsBlocked,
} from "./describe-agent-availability";

function stateWith(
  sandbox: ThreadSandbox,
  supervisor: Pick<ThreadState, "isSupervisorConnected" | "hasSeenSupervisorConnected">,
): ThreadState {
  return {
    ...initialThreadState,
    record: { name: "found", sandbox },
    connection: { name: "connected" },
    ...supervisor,
  };
}

const neverConnected = { isSupervisorConnected: false, hasSeenSupervisorConnected: false };
const connected = { isSupervisorConnected: true, hasSeenSupervisorConnected: true };
const wentAway = { isSupervisorConnected: false, hasSeenSupervisorConnected: true };

describe("the agent's availability", () => {
  it("is loading until the thread's record arrives", () => {
    expect(describeAgentAvailability(initialThreadState)).toEqual({ name: "loading" });
  });

  it("is starting while the sandbox is being created", () => {
    expect(describeAgentAvailability(stateWith({ state: "creating" }, neverConnected))).toEqual({
      name: "starting",
    });
  });

  it("is still starting once the sandbox exists, until its supervisor first connects", () => {
    expect(describeAgentAvailability(stateWith({ state: "ready" }, neverConnected))).toEqual({
      name: "starting",
    });
  });

  it("is connected while the supervisor is", () => {
    expect(describeAgentAvailability(stateWith({ state: "ready" }, connected))).toEqual({
      name: "connected",
    });
  });

  it("is not connected once a supervisor that had connected goes", () => {
    expect(describeAgentAvailability(stateWith({ state: "ready" }, wentAway))).toEqual({
      name: "not_connected",
    });
  });

  it("carries the reason when the sandbox could not be created", () => {
    const failed = stateWith({ state: "failed", reason: "No quota left" }, neverConnected);

    expect(describeAgentAvailability(failed)).toEqual({
      name: "sandbox_failed",
      reason: "No quota left",
    });
  });
});

describe("why sending is blocked", () => {
  it("is nothing while the agent is connected", () => {
    expect(describeWhySendingIsBlocked(stateWith({ state: "ready" }, connected))).toBeUndefined();
  });

  it("is the page's own connection before anything else", () => {
    const disconnected: ThreadState = {
      ...stateWith({ state: "ready" }, connected),
      connection: { name: "reconnecting" },
    };

    expect(describeWhySendingIsBlocked(disconnected)).toBe(
      "Waiting for the connection to the control plane.",
    );
  });

  it("is nothing while the sandbox is starting, since a message waits for the agent", () => {
    expect(
      describeWhySendingIsBlocked(stateWith({ state: "creating" }, neverConnected)),
    ).toBeUndefined();
  });

  it("says when the sandbox could not be created, so no agent will ever read a message", () => {
    expect(
      describeWhySendingIsBlocked(stateWith({ state: "failed", reason: "x" }, neverConnected)),
    ).toMatch(/could not be created/);
  });
});
