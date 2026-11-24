import type {
  AssistantTextFragment,
  ControlPlaneToClientMessage,
  ThreadEvent,
  ThreadSummary,
} from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import {
  initialThreadState,
  isWaitingForAgent,
  reduceThreadState,
  type ThreadAction,
  type ThreadState,
} from "./thread-state";

const exampleThread: ThreadSummary = {
  threadId: "thread-1",
  createdAt: "2026-11-24T09:00:00.000Z",
  lastActiveAt: "2026-11-24T09:00:00.000Z",
  title: "Fix the build",
  isAgentWorking: false,
  sandbox: { state: "running" },
  repository: null,
};

function recorded(sequence: number, event: ThreadEvent): ThreadAction {
  return {
    type: "message_received",
    message: { type: "thread_event", sequence, recordedAt: "2026-11-24T09:00:00.000Z", event },
  };
}

function received(message: ControlPlaneToClientMessage): ThreadAction {
  return { type: "message_received", message };
}

function fragment(
  messageId: string,
  appendedText: string,
  contentBlockIndex = 0,
  contentBlockType: AssistantTextFragment["contentBlockType"] = "text",
): ThreadAction {
  return received({
    type: "stream_fragment",
    fragment: {
      type: "assistant_text_fragment",
      messageId,
      contentBlockIndex,
      contentBlockType,
      appendedText,
    },
  });
}

function announcement(firstSequence: number, lastSequence: number): ThreadAction {
  return received({ type: "replay_announcement", firstSequence, lastSequence });
}

function stateAfter(...actions: ThreadAction[]): ThreadState {
  return actions.reduce(reduceThreadState, initialThreadState);
}

const completedHello: ThreadEvent = {
  type: "assistant_message",
  messageId: "assistant-1",
  content: [
    { type: "thinking", text: "The user wants a greeting." },
    { type: "text", text: "Hello there." },
  ],
  endReason: "completed",
};

describe("thread events", () => {
  it("are applied in order and advance the last seen sequence", () => {
    const state = stateAfter(
      recorded(1, { type: "user_message", messageId: "user-1", text: "Say hello" }),
      recorded(2, { type: "agent_run_started" }),
    );

    expect(state.lastSeenSequence).toBe(2);
    expect(state.entries).toEqual([
      { kind: "user_message", key: "user:user-1", sequence: 1, text: "Say hello" },
    ]);
  });

  it("are ignored when their sequence has already been seen, as in an overlapping replay", () => {
    const userMessage: ThreadEvent = {
      type: "user_message",
      messageId: "user-1",
      text: "Say hello",
    };
    const once = stateAfter(recorded(1, userMessage));

    const replayedAgain = reduceThreadState(once, recorded(1, userMessage));

    expect(replayedAgain).toBe(once);
  });
});

describe("repository events", () => {
  it("each become an entry in the conversation, in order, without starting a run", () => {
    const cloned: ThreadEvent = {
      type: "repository_cloned",
      baseBranch: "main",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      workBranch: "barrack/thread-1",
      lostEarlierWork: false,
    };
    const state = stateAfter(
      recorded(1, {
        type: "repository_clone_started",
        repositoryUrl: "https://github.com/octo/app",
        baseBranch: null,
      }),
      recorded(2, cloned),
    );

    expect(state.entries.map((entry) => entry.kind)).toEqual([
      "repository_event",
      "repository_event",
    ]);
    expect(state.entries[1]).toEqual({ kind: "repository_event", key: "event:2", event: cloned });
    expect(state.isAgentWorking).toBe(false);
  });
});

describe("stream fragments", () => {
  it("accumulate into the content block they belong to", () => {
    const state = stateAfter(
      fragment("assistant-1", "Thinking ", 0, "thinking"),
      fragment("assistant-1", "Hel", 1),
      fragment("assistant-1", "hard.", 0, "thinking"),
      fragment("assistant-1", "lo", 1),
    );

    expect(state.entries).toEqual([
      {
        kind: "streaming_assistant_message",
        key: "assistant:assistant-1",
        messageId: "assistant-1",
        blocks: [
          { contentBlockIndex: 0, contentBlockType: "thinking", text: "Thinking hard." },
          { contentBlockIndex: 1, contentBlockType: "text", text: "Hello" },
        ],
      },
    ]);
  });

  it("keep content blocks in index order even when a later block streams first", () => {
    const state = stateAfter(fragment("assistant-1", "B", 1), fragment("assistant-1", "A", 0));

    const entry = state.entries[0];
    expect(
      entry?.kind === "streaming_assistant_message" && entry.blocks.map((block) => block.text),
    ).toEqual(["A", "B"]);
  });

  it("are superseded by the completed message, which takes their place in the conversation", () => {
    const state = stateAfter(
      recorded(1, { type: "user_message", messageId: "user-1", text: "Say hello" }),
      fragment("assistant-1", "Hel", 1),
      recorded(2, completedHello),
    );

    expect(state.entries).toEqual([
      { kind: "user_message", key: "user:user-1", sequence: 1, text: "Say hello" },
      {
        kind: "assistant_message",
        key: "assistant:assistant-1",
        messageId: "assistant-1",
        content: completedHello.type === "assistant_message" ? completedHello.content : [],
        endReason: "completed",
        errorMessage: undefined,
      },
    ]);
  });

  it("are ignored once the completed message has been applied", () => {
    const completed = stateAfter(recorded(1, completedHello));

    const afterLateFragment = reduceThreadState(completed, fragment("assistant-1", "stale"));

    expect(afterLateFragment).toBe(completed);
  });

  it("of a message that was never completed are discarded when the run settles", () => {
    const state = stateAfter(
      recorded(1, { type: "agent_run_started" }),
      fragment("assistant-1", "Half a sen"),
      recorded(2, { type: "agent_run_settled", wasInterrupted: false }),
    );

    expect(state.entries).toEqual([]);
  });

  it("of a message that was never completed are discarded when the agent fails", () => {
    const state = stateAfter(
      recorded(1, { type: "agent_run_started" }),
      fragment("assistant-1", "Half a sen"),
      recorded(2, { type: "agent_failed", errorMessage: "Pi exited with code 1" }),
    );

    expect(state.entries).toEqual([
      { kind: "agent_failed", key: "event:2", errorMessage: "Pi exited with code 1" },
    ]);
  });

  it("of a message that was never completed are discarded when another message starts streaming", () => {
    const state = stateAfter(fragment("assistant-1", "Abandoned"), fragment("assistant-2", "Next"));

    expect(state.entries.map((entry) => entry.key)).toEqual(["assistant:assistant-2"]);
  });

  it("are dropped on reconnect, because the control plane resends the text so far", () => {
    const streaming = stateAfter(
      recorded(1, { type: "agent_run_started" }),
      fragment("assistant-1", "Hel"),
    );

    const reconnected = reduceThreadState(streaming, announcement(2, 1));

    expect(reconnected.entries).toEqual([]);
    expect(reconnected.lastSeenSequence).toBe(1);
  });
});

describe("a replay announcement", () => {
  it("keeps the conversation when it continues from the last seen sequence", () => {
    const state = stateAfter(
      recorded(1, { type: "user_message", messageId: "user-1", text: "Hi" }),
    );

    const reconnected = reduceThreadState(state, announcement(2, 4));

    expect(reconnected.entries).toEqual(state.entries);
    expect(reconnected.lastSeenSequence).toBe(1);
  });

  it("discards the conversation when the control plane replays from before what was seen", () => {
    const state = stateAfter(
      recorded(1, { type: "user_message", messageId: "user-1", text: "Hi" }),
      recorded(2, { type: "agent_run_started" }),
    );

    const replaced = reduceThreadState(state, announcement(1, 0));

    expect(replaced.entries).toEqual([]);
    expect(replaced.lastSeenSequence).toBe(0);
    expect(replaced.isAgentWorking).toBe(false);
  });
});

describe("whether the agent is working", () => {
  it("is true from the start of a run until it settles", () => {
    const started = stateAfter(recorded(1, { type: "agent_run_started" }));

    const settled = reduceThreadState(
      started,
      recorded(2, { type: "agent_run_settled", wasInterrupted: false }),
    );

    expect(started.isAgentWorking).toBe(true);
    expect(settled.isAgentWorking).toBe(false);
  });

  it("stays true across assistant messages and tool executions within a run", () => {
    const state = stateAfter(
      recorded(1, { type: "agent_run_started" }),
      recorded(2, { ...completedHello, endReason: "tool_use_requested" }),
      recorded(3, {
        type: "tool_execution_started",
        toolCallId: "call-1",
        toolName: "bash",
        arguments: {},
      }),
    );

    expect(state.isAgentWorking).toBe(true);
  });

  it("is false after the agent fails, which is shown as an error", () => {
    const state = stateAfter(
      recorded(1, { type: "agent_run_started" }),
      recorded(2, { type: "agent_failed", errorMessage: "Pi exited with code 1" }),
    );

    expect(state.isAgentWorking).toBe(false);
    expect(state.entries).toEqual([
      { kind: "agent_failed", key: "event:2", errorMessage: "Pi exited with code 1" },
    ]);
  });

  it("is false after an interrupted run settles, which is noted in the conversation", () => {
    const state = stateAfter(
      recorded(1, { type: "agent_run_started" }),
      recorded(2, { type: "agent_run_settled", wasInterrupted: true }),
    );

    expect(state.isAgentWorking).toBe(false);
    expect(state.entries).toEqual([{ kind: "agent_interrupted", key: "event:2" }]);
  });
});

describe("tool executions", () => {
  it("are shown as running when they start", () => {
    const state = stateAfter(
      recorded(1, {
        type: "tool_execution_started",
        toolCallId: "call-1",
        toolName: "bash",
        arguments: { command: "ls" },
      }),
    );

    expect(state.entries).toEqual([
      {
        kind: "tool_execution",
        key: "tool:call-1",
        toolCallId: "call-1",
        toolName: "bash",
        arguments: { command: "ls" },
        outcome: { status: "running" },
      },
    ]);
  });

  it("are updated in place by the matching finish, even with other entries in between", () => {
    const output = { text: "README.md\n", isTruncated: false, originalSizeInBytes: 10 };

    const state = stateAfter(
      recorded(1, {
        type: "tool_execution_started",
        toolCallId: "call-1",
        toolName: "bash",
        arguments: { command: "ls" },
      }),
      recorded(2, {
        type: "tool_execution_started",
        toolCallId: "call-2",
        toolName: "read",
        arguments: { path: "a" },
      }),
      recorded(3, {
        type: "tool_execution_finished",
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
        output,
        durationInMilliseconds: 40,
      }),
      recorded(4, {
        type: "tool_execution_finished",
        toolCallId: "call-2",
        toolName: "read",
        isError: true,
        output: { text: "No such file", isTruncated: false, originalSizeInBytes: 12 },
      }),
    );

    expect(
      state.entries.map(
        (entry) => entry.kind === "tool_execution" && [entry.toolCallId, entry.outcome.status],
      ),
    ).toEqual([
      ["call-1", "finished"],
      ["call-2", "errored"],
    ]);
    expect(state.entries[0]).toMatchObject({
      arguments: { command: "ls" },
      outcome: { status: "finished", output, durationInMilliseconds: 40 },
    });
  });
});

describe("errored assistant messages", () => {
  it("keep the provider's error message to show the user", () => {
    const state = stateAfter(
      recorded(1, {
        type: "assistant_message",
        messageId: "assistant-1",
        content: [],
        endReason: "errored",
        errorMessage: "Your plan's usage limit has been reached.",
      }),
    );

    expect(state.entries[0]).toMatchObject({
      kind: "assistant_message",
      endReason: "errored",
      errorMessage: "Your plan's usage limit has been reached.",
    });
  });
});

describe("the supervisor connection status", () => {
  it("follows what the control plane reports", () => {
    const connected = stateAfter(
      { type: "connection_changed", connection: { name: "connected" } },
      received({ type: "supervisor_connection_status", isSupervisorConnected: true }),
    );

    expect(connected.isSupervisorConnected).toBe(true);
  });

  it("is no longer claimed once the page loses its own connection", () => {
    const disconnected = stateAfter(
      { type: "connection_changed", connection: { name: "connected" } },
      received({ type: "supervisor_connection_status", isSupervisorConnected: true }),
      { type: "connection_changed", connection: { name: "reconnecting" } },
    );

    expect(disconnected.isSupervisorConnected).toBe(false);
  });

  it("remembers that the supervisor has connected since the page opened, even after it goes", () => {
    const neverConnected = stateAfter(
      received({ type: "supervisor_connection_status", isSupervisorConnected: false }),
    );
    const connectedThenGone = stateAfter(
      received({ type: "supervisor_connection_status", isSupervisorConnected: true }),
      received({ type: "supervisor_connection_status", isSupervisorConnected: false }),
    );

    expect(neverConnected.hasSeenSupervisorConnected).toBe(false);
    expect(connectedThenGone.hasSeenSupervisorConnected).toBe(true);
  });
});

describe("user messages waiting for the agent", () => {
  it("are told apart from delivered ones by their sequence and the delivery status", () => {
    const state = stateAfter(
      recorded(1, { type: "user_message", messageId: "user-1", text: "Delivered" }),
      recorded(2, { type: "user_message", messageId: "user-2", text: "Waiting" }),
      received({ type: "user_message_delivery_status", deliveredThroughSequence: 1 }),
    );

    expect(waitingKeys(state)).toEqual(["user:user-2"]);
  });

  it("are not shown while a page catches up, before the control plane says how far delivery has got", () => {
    const state = stateAfter(
      received({ type: "replay_announcement", firstSequence: 1, lastSequence: 1 }),
      recorded(1, { type: "user_message", messageId: "user-1", text: "Delivered long ago" }),
    );

    expect(waitingKeys(state)).toEqual([]);
  });

  it("are judged afresh when the control plane replaces the history the page held", () => {
    const state = stateAfter(
      recorded(1, { type: "user_message", messageId: "user-1", text: "Old" }),
      received({ type: "user_message_delivery_status", deliveredThroughSequence: 1 }),
      received({ type: "replay_announcement", firstSequence: 1, lastSequence: 1 }),
    );

    expect(state.userMessagesDeliveredThroughSequence).toBeUndefined();
  });
});

function waitingKeys(state: ThreadState): string[] {
  return state.entries.flatMap((entry) =>
    entry.kind === "user_message" &&
    isWaitingForAgent(state.userMessagesDeliveredThroughSequence, entry)
      ? [entry.key]
      : [],
  );
}

describe("the thread's record", () => {
  it("is loading until the control plane's record arrives", () => {
    expect(initialThreadState.record).toEqual({ name: "loading" });
  });

  it("holds the thread as the latest record tells it", () => {
    const failedThread = {
      ...exampleThread,
      sandbox: { state: "failed", reason: "No quota left", canResume: false },
    } as const;

    const failed = stateAfter(
      { type: "thread_record_loaded", thread: exampleThread },
      { type: "thread_record_loaded", thread: failedThread },
    );

    expect(failed.record).toEqual({ name: "found", thread: failedThread });
  });

  it("forgets having seen a supervisor once the sandbox is no longer running, so a restart shows as starting", () => {
    const supervisorConnected: ControlPlaneToClientMessage = {
      type: "supervisor_connection_status",
      isSupervisorConnected: true,
    };
    const supervisorGone: ControlPlaneToClientMessage = {
      type: "supervisor_connection_status",
      isSupervisorConnected: false,
    };

    const restarted = stateAfter(
      { type: "connection_changed", connection: { name: "connected" } },
      { type: "message_received", message: supervisorConnected },
      { type: "message_received", message: supervisorGone },
      { type: "thread_record_loaded", thread: { ...exampleThread, sandbox: { state: "stopped" } } },
      { type: "thread_record_loaded", thread: exampleThread },
    );

    expect(restarted.hasSeenSupervisorConnected).toBe(false);
  });

  it("says when the control plane has no such thread", () => {
    expect(stateAfter({ type: "thread_record_missing" }).record).toEqual({ name: "not_found" });
  });
});

describe("stopping, resuming and deleting", () => {
  it("asks to confirm a deletion first, and forgets it when cancelled", () => {
    const confirming = stateAfter({ type: "delete_confirmation_requested" });
    const cancelled = reduceThreadState(confirming, { type: "delete_confirmation_cancelled" });

    expect(confirming.lifecycleRequest).toEqual({ name: "confirming_delete" });
    expect(cancelled.lifecycleRequest).toEqual({ name: "none" });
  });

  it("shows a request as sending, then takes the thread as the control plane answered", () => {
    const stopping = { ...exampleThread, sandbox: { state: "stopping" } } as const;

    const sending = stateAfter({ type: "lifecycle_request_sent", action: "stop" });
    const answered = reduceThreadState(sending, {
      type: "lifecycle_request_answered",
      thread: stopping,
    });

    expect(sending.lifecycleRequest).toEqual({ name: "sending", action: "stop" });
    expect(answered.lifecycleRequest).toEqual({ name: "none" });
    expect(answered.record).toEqual({ name: "found", thread: stopping });
  });

  it("shows why a request was refused until dismissed", () => {
    const refused = stateAfter(
      { type: "lifecycle_request_sent", action: "resume" },
      { type: "lifecycle_request_failed", reason: "You already have 3 sandboxes running" },
    );

    expect(refused.lifecycleRequest).toEqual({ name: "none" });
    expect(refused.rejectionReason).toBe("You already have 3 sandboxes running");
  });
});

describe("rejections", () => {
  it("are kept for the user to read until dismissed", () => {
    const rejected = stateAfter(
      received({ type: "client_message_rejected", reason: "No agent is connected." }),
    );

    const dismissed = reduceThreadState(rejected, { type: "rejection_dismissed" });

    expect(rejected.rejectionReason).toBe("No agent is connected.");
    expect(dismissed.rejectionReason).toBeUndefined();
  });
});

describe("messages the user sent that are not yet confirmed", () => {
  const sent: ThreadAction = { type: "user_message_sent", messageId: "message-a", text: "Hello" };
  const connected: ThreadAction = { type: "connection_changed", connection: { name: "connected" } };
  const dropped: ThreadAction = {
    type: "connection_changed",
    connection: { name: "reconnecting" },
  };
  const userMessage: ThreadEvent = { type: "user_message", messageId: "message-a", text: "Hello" };

  it("are shown as sending until their thread event arrives, which takes their place", () => {
    const sending = stateAfter(connected, sent);
    const confirmed = reduceThreadState(sending, recorded(1, userMessage));

    expect(sending.unconfirmedUserMessages).toEqual([
      { messageId: "message-a", text: "Hello", status: "sending" },
    ]);
    expect(confirmed.unconfirmedUserMessages).toEqual([]);
    expect(confirmed.entries).toHaveLength(1);
  });

  it("are offered to be sent again under the same identifier when the control plane refuses them", () => {
    const refused = stateAfter(
      connected,
      sent,
      received({
        type: "client_message_rejected",
        reason: "The message could not be saved.",
        messageId: "message-a",
      }),
    );
    const sentAgain = reduceThreadState(refused, sent);

    expect(refused.unconfirmedUserMessages).toEqual([
      { messageId: "message-a", text: "Hello", status: "not_sent" },
    ]);
    expect(refused.rejectionReason).toBe("The message could not be saved.");
    expect(sentAgain.unconfirmedUserMessages).toEqual([
      { messageId: "message-a", text: "Hello", status: "sending" },
    ]);
  });

  it("are not touched by the refusal of something else, such as an interrupt", () => {
    const state = stateAfter(
      connected,
      sent,
      received({ type: "client_message_rejected", reason: "No agent is connected." }),
    );

    expect(state.unconfirmedUserMessages[0]?.status).toBe("sending");
  });

  it("are offered to be sent again when the connection drops, and forgotten if the replay shows them recorded", () => {
    const afterDrop = stateAfter(connected, sent, dropped);
    const afterReplay = stateAfter(
      connected,
      sent,
      dropped,
      connected,
      announcement(1, 1),
      recorded(1, userMessage),
    );

    expect(afterDrop.unconfirmedUserMessages[0]?.status).toBe("not_sent");
    expect(afterReplay.unconfirmedUserMessages).toEqual([]);
  });

  it("are forgotten when the user discards them", () => {
    const discarded = stateAfter(connected, sent, {
      type: "user_message_discarded",
      messageId: "message-a",
    });

    expect(discarded.unconfirmedUserMessages).toEqual([]);
  });
});
