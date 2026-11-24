import type { ThreadSandbox } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import { initialThreadState, type ThreadState } from "../thread-state/thread-state";
import {
  describeAgentAvailability,
  describeWaitingMessage,
  describeWhySendingIsBlocked,
} from "./describe-agent-availability";

function stateWith(
  sandbox: ThreadSandbox,
  supervisor: Pick<ThreadState, "isSupervisorConnected" | "hasSeenSupervisorConnected">,
): ThreadState {
  return {
    ...initialThreadState,
    record: {
      name: "found",
      thread: {
        threadId: "thread-1",
        createdAt: "2026-11-24T09:00:00.000Z",
        lastActiveAt: "2026-11-24T09:00:00.000Z",
        title: null,
        isAgentWorking: false,
        repository: null,
        model: null,
        sandbox,
      },
    },
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

  it("is still starting once the sandbox runs, until its supervisor first connects", () => {
    expect(describeAgentAvailability(stateWith({ state: "running" }, neverConnected))).toEqual({
      name: "starting",
    });
  });

  it("is connected while the supervisor is", () => {
    expect(describeAgentAvailability(stateWith({ state: "running" }, connected))).toEqual({
      name: "connected",
    });
  });

  it("is not connected once a supervisor that had connected goes", () => {
    expect(describeAgentAvailability(stateWith({ state: "running" }, wentAway))).toEqual({
      name: "not_connected",
    });
  });

  it.each([
    [{ state: "starting" }, "waking"],
    [{ state: "stopping" }, "stopping"],
    [{ state: "stopped" }, "stopped"],
    [{ state: "deleting" }, "deleting"],
  ] as const)("follows the sandbox while it is %o", (sandbox, name) => {
    expect(describeAgentAvailability(stateWith(sandbox, wentAway))).toEqual({ name });
  });

  it("believes a connected supervisor over a record a moment old that says the sandbox is stopped or waking", () => {
    expect(describeAgentAvailability(stateWith({ state: "stopped" }, connected))).toEqual({
      name: "connected",
    });
    expect(describeAgentAvailability(stateWith({ state: "starting" }, connected))).toEqual({
      name: "connected",
    });
    expect(describeAgentAvailability(stateWith({ state: "stopping" }, connected))).toEqual({
      name: "stopping",
    });
  });

  it("carries the reason when the sandbox failed, and whether it can be resumed", () => {
    const failed = stateWith(
      { state: "failed", reason: "No quota left", canResume: true },
      neverConnected,
    );

    expect(describeAgentAvailability(failed)).toEqual({
      name: "sandbox_failed",
      reason: "No quota left",
      canResume: true,
    });
  });
});

describe("why sending is blocked", () => {
  it("is nothing while the agent is connected", () => {
    expect(describeWhySendingIsBlocked(stateWith({ state: "running" }, connected))).toBeUndefined();
  });

  it("is the page's own connection before anything else", () => {
    const disconnected: ThreadState = {
      ...stateWith({ state: "running" }, connected),
      connection: { name: "reconnecting" },
    };

    expect(describeWhySendingIsBlocked(disconnected)).toBe(
      "Waiting for the connection to the control plane.",
    );
  });

  it.each([
    { state: "creating" },
    { state: "starting" },
    { state: "stopping" },
    { state: "stopped" },
  ] as const)(
    "is nothing while the sandbox is %o, since a message waits for the agent or wakes it",
    (sandbox) => {
      expect(describeWhySendingIsBlocked(stateWith(sandbox, neverConnected))).toBeUndefined();
    },
  );

  it("asks for a failed sandbox to be resumed, and says when it is gone", () => {
    const resumable = { state: "failed", reason: "x", canResume: true } as const;
    const gone = { state: "failed", reason: "x", canResume: false } as const;

    expect(describeWhySendingIsBlocked(stateWith(resumable, neverConnected))).toMatch(/Resume it/);
    expect(describeWhySendingIsBlocked(stateWith(gone, neverConnected))).toMatch(/is gone/);
  });

  it("says when the thread is being deleted", () => {
    expect(describeWhySendingIsBlocked(stateWith({ state: "deleting" }, connected))).toMatch(
      /being deleted/,
    );
  });
});

describe("what a message waiting for the agent says", () => {
  it("is that it will be delivered when the agent connects, while the sandbox runs or wakes", () => {
    for (const sandbox of [{ state: "running" }, { state: "starting" }] as const) {
      expect(describeWaitingMessage(stateWith(sandbox, wentAway))).toMatch(/as soon as/);
    }
  });

  it("asks for the thread to be resumed when its sandbox is stopped or failed, since nothing else wakes it", () => {
    const failed = { state: "failed", reason: "x", canResume: true } as const;

    expect(describeWaitingMessage(stateWith({ state: "stopped" }, wentAway))).toMatch(
      /Resume the thread/,
    );
    expect(describeWaitingMessage(stateWith(failed, wentAway))).toMatch(/Resume the thread/);
  });

  it("says it will not be delivered when the sandbox is gone", () => {
    const gone = { state: "failed", reason: "x", canResume: false } as const;

    expect(describeWaitingMessage(stateWith(gone, wentAway))).toMatch(/Not delivered/);
  });
});
