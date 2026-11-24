import type { ThreadSandbox } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import {
  availableLifecycleActions,
  describeSandboxBanner,
  describeSandboxState,
  describeTimeSince,
  isSandboxChanging,
  threadNameOf,
} from "./describe-sandbox";

describe("a thread's name", () => {
  it("is its title, or says it is new until it has one", () => {
    expect(threadNameOf({ title: "Fix the build" })).toBe("Fix the build");
    expect(threadNameOf({ title: null })).toBe("New thread");
  });
});

describe("what can be asked of a sandbox", () => {
  it.each<[ThreadSandbox, { canStop: boolean; canResume: boolean; canDelete: boolean }]>([
    [{ state: "creating" }, { canStop: false, canResume: false, canDelete: false }],
    [{ state: "running" }, { canStop: true, canResume: false, canDelete: true }],
    [{ state: "stopping" }, { canStop: false, canResume: false, canDelete: false }],
    [{ state: "stopped" }, { canStop: false, canResume: true, canDelete: true }],
    [{ state: "starting" }, { canStop: false, canResume: false, canDelete: false }],
    [
      { state: "failed", reason: "x", canResume: true },
      { canStop: false, canResume: true, canDelete: true },
    ],
    [
      { state: "failed", reason: "x", canResume: false },
      { canStop: false, canResume: false, canDelete: true },
    ],
    [{ state: "deleting" }, { canStop: false, canResume: false, canDelete: false }],
  ])("when it is %o: %o", (sandbox, actions) => {
    expect(availableLifecycleActions(sandbox)).toEqual(actions);
  });
});

describe("how a sandbox is described", () => {
  it("names each state in a word or two, and which are changing", () => {
    const sandboxes: ThreadSandbox[] = [
      { state: "creating" },
      { state: "running" },
      { state: "stopping" },
      { state: "stopped" },
      { state: "starting" },
      { state: "failed", reason: "x", canResume: true },
      { state: "failed", reason: "x", canResume: false },
      { state: "deleting" },
    ];

    expect(sandboxes.map(describeSandboxState)).toEqual([
      "Starting…",
      "Running",
      "Stopping…",
      "Stopped",
      "Waking…",
      "Failed",
      "Sandbox gone",
      "Deleting…",
    ]);
    expect(sandboxes.filter(isSandboxChanging).map((sandbox) => sandbox.state)).toEqual([
      "creating",
      "stopping",
      "starting",
      "deleting",
    ]);
  });

  it("shows no banner for a sandbox simply running, and one for waking, stopped or a problem", () => {
    expect(describeSandboxBanner({ state: "running" })).toBeUndefined();
    expect(describeSandboxBanner({ state: "starting" })).toEqual({
      tone: "quiet",
      text: "Waking the sandbox… Messages wait until the agent is back.",
    });
    expect(describeSandboxBanner({ state: "stopped" })?.text).toMatch(/Send a message to wake it/);
    expect(describeSandboxBanner({ state: "running", problem: "Could not stop it." })).toEqual({
      tone: "warning",
      text: "Could not stop it.",
    });
  });
});

describe("how long ago", () => {
  const now = new Date("2026-11-24T12:00:00.000Z");

  it.each([
    ["2026-11-24T11:59:30.000Z", "just now"],
    ["2026-11-24T11:55:00.000Z", "5 min ago"],
    ["2026-11-24T09:00:00.000Z", "3 h ago"],
    ["2026-11-23T11:00:00.000Z", "yesterday"],
    ["2026-11-20T12:00:00.000Z", "4 days ago"],
    ["2026-11-24T12:00:05.000Z", "just now"],
  ])("puts %s as %s", (time, description) => {
    expect(describeTimeSince(time, now)).toBe(description);
  });
});
