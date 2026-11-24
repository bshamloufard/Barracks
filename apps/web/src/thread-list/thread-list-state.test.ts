import type { ThreadSummary } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import {
  initialThreadListState,
  reduceThreadListState,
  type ThreadListAction,
  type ThreadListState,
} from "./thread-list-state";

const thread: ThreadSummary = {
  threadId: "thread-1",
  createdAt: "2026-11-24T09:00:00.000Z",
  lastActiveAt: "2026-11-24T09:00:00.000Z",
  title: null,
  isAgentWorking: false,
  sandbox: { state: "running" },
  repository: null,
};

function stateAfter(...actions: ThreadListAction[]): ThreadListState {
  return actions.reduce(reduceThreadListState, initialThreadListState);
}

describe("the thread list", () => {
  it("is loading until the threads arrive, then holds them as the control plane ordered them", () => {
    const loaded = stateAfter({ type: "list_loaded", threads: [thread] });

    expect(initialThreadListState.list).toEqual({ name: "loading" });
    expect(loaded.list).toEqual({ name: "loaded", threads: [thread] });
  });

  it("says why the threads could not be loaded, and loads again when asked", () => {
    const failed = stateAfter({ type: "list_failed", reason: "The control plane is down" });
    const retrying = reduceThreadListState(failed, { type: "list_requested" });

    expect(failed.list).toEqual({ name: "failed", reason: "The control plane is down" });
    expect(retrying.list).toEqual({ name: "loading" });
  });
});

describe("creating a thread from the list", () => {
  it("is shown as under way, so it is not asked for twice", () => {
    expect(stateAfter({ type: "creation_started" }).isCreatingThread).toBe(true);
  });

  it("says why it failed, and forgets that when tried again", () => {
    const failed = stateAfter(
      { type: "creation_started" },
      { type: "creation_failed", reason: "Origin not allowed" },
    );
    const retried = reduceThreadListState(failed, { type: "creation_started" });

    expect(failed).toMatchObject({
      isCreatingThread: false,
      creationFailureReason: "Origin not allowed",
    });
    expect(retried.creationFailureReason).toBeUndefined();
  });
});
