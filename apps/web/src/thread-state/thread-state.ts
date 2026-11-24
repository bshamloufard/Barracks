import type {
  AssistantContentBlock,
  AssistantMessageEndReason,
  AssistantTextFragment,
  ControlPlaneToClientMessage,
  RecordedThreadEvent,
  ReplayAnnouncement,
  ToolArguments,
  ToolOutput,
} from "@barrack/protocol";

/**
 * Everything the page shows about one thread, and the only code that changes
 * it. These are pure functions of the previous state and what arrived, with
 * no React and no sockets, so every rule about ordering and replay can be
 * tested directly.
 */

export type UserMessageEntry = {
  kind: "user_message";
  key: string;
  text: string;
};

export type StreamedContentBlock = Pick<
  AssistantTextFragment,
  "contentBlockIndex" | "contentBlockType"
> & { text: string };

/** An assistant message still being produced, assembled from stream fragments. */
export type StreamingAssistantMessageEntry = {
  kind: "streaming_assistant_message";
  key: string;
  messageId: string;
  blocks: StreamedContentBlock[];
};

/** A completed assistant message, as recorded. It replaces the streaming entry for the same message. */
export type AssistantMessageEntry = {
  kind: "assistant_message";
  key: string;
  messageId: string;
  content: AssistantContentBlock[];
  endReason: AssistantMessageEndReason;
  errorMessage: string | undefined;
};

export type ToolExecutionOutcome =
  | { status: "running" }
  | {
      status: "finished" | "errored";
      output: ToolOutput;
      durationInMilliseconds: number | undefined;
    };

export type ToolExecutionEntry = {
  kind: "tool_execution";
  key: string;
  toolCallId: string;
  toolName: string;
  arguments: ToolArguments;
  outcome: ToolExecutionOutcome;
};

export type AgentFailedEntry = { kind: "agent_failed"; key: string; errorMessage: string };

export type AgentInterruptedEntry = { kind: "agent_interrupted"; key: string };

export type ConversationEntry =
  | UserMessageEntry
  | StreamingAssistantMessageEntry
  | AssistantMessageEntry
  | ToolExecutionEntry
  | AgentFailedEntry
  | AgentInterruptedEntry;

export type ConnectionState =
  | { name: "connecting" }
  | { name: "connected" }
  | { name: "reconnecting" }
  /** The page has given up reconnecting, because doing so would not help. */
  | { name: "stopped"; reason: string };

export type ThreadState = {
  /** The sequence of the newest thread event applied, or 0 for none. Sent when reconnecting. */
  lastSeenSequence: number;
  entries: ConversationEntry[];
  /** A run has started and has not yet settled or failed. */
  isAgentWorking: boolean;
  isSupervisorConnected: boolean;
  connection: ConnectionState;
  /** Why the control plane refused the last thing this page sent, until the user dismisses it. */
  rejectionReason: string | undefined;
};

export type ThreadAction =
  | { type: "message_received"; message: ControlPlaneToClientMessage }
  | { type: "connection_changed"; connection: ConnectionState }
  | { type: "rejection_dismissed" };

export const initialThreadState: ThreadState = {
  lastSeenSequence: 0,
  entries: [],
  isAgentWorking: false,
  isSupervisorConnected: false,
  connection: { name: "connecting" },
  rejectionReason: undefined,
};

export function reduceThreadState(state: ThreadState, action: ThreadAction): ThreadState {
  switch (action.type) {
    case "message_received":
      return applyControlPlaneMessage(state, action.message);
    case "connection_changed":
      return applyConnectionChange(state, action.connection);
    case "rejection_dismissed":
      return { ...state, rejectionReason: undefined };
  }
}

export function applyControlPlaneMessage(
  state: ThreadState,
  message: ControlPlaneToClientMessage,
): ThreadState {
  switch (message.type) {
    case "replay_announcement":
      return applyReplayAnnouncement(state, message);
    case "thread_event":
      return applyRecordedEvent(state, message);
    case "stream_fragment":
      return applyAssistantTextFragment(state, message.fragment);
    case "supervisor_connection_status":
      return { ...state, isSupervisorConnected: message.isSupervisorConnected };
    case "client_message_rejected":
      return { ...state, rejectionReason: message.reason };
  }
}

/**
 * Each new connection starts with an announcement. Streaming entries are
 * dropped because the control plane follows the replay with the text so far
 * of every unfinished message; keeping them would show that text twice.
 *
 * An announcement that starts at or before what this page has already seen
 * means the control plane no longer holds that history (it was restarted)
 * and is replaying the thread from the start, so everything held is discarded.
 */
export function applyReplayAnnouncement(
  state: ThreadState,
  announcement: ReplayAnnouncement,
): ThreadState {
  const isHistoryReplacement = announcement.firstSequence <= state.lastSeenSequence;
  if (isHistoryReplacement) {
    return {
      ...state,
      entries: [],
      lastSeenSequence: announcement.firstSequence - 1,
      isAgentWorking: false,
    };
  }
  return {
    ...state,
    entries: state.entries.filter((entry) => entry.kind !== "streaming_assistant_message"),
  };
}

/** Applies a recorded thread event once; a sequence already seen is ignored. */
export function applyRecordedEvent(
  state: ThreadState,
  recordedEvent: RecordedThreadEvent,
): ThreadState {
  if (recordedEvent.sequence <= state.lastSeenSequence) {
    return state;
  }
  return {
    ...applyThreadEvent(state, recordedEvent),
    lastSeenSequence: recordedEvent.sequence,
  };
}

function applyThreadEvent(
  state: ThreadState,
  { sequence, event }: RecordedThreadEvent,
): ThreadState {
  switch (event.type) {
    case "user_message":
      return appendEntry(state, {
        kind: "user_message",
        key: `user:${event.messageId}`,
        text: event.text,
      });
    case "agent_run_started":
      return { ...state, isAgentWorking: true };
    case "assistant_message":
      return replaceOrAppendEntry(state, {
        kind: "assistant_message",
        key: assistantEntryKey(event.messageId),
        messageId: event.messageId,
        content: event.content,
        endReason: event.endReason,
        errorMessage: event.errorMessage,
      });
    case "tool_execution_started":
      return replaceOrAppendEntry(state, {
        kind: "tool_execution",
        key: toolEntryKey(event.toolCallId),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        arguments: event.arguments,
        outcome: { status: "running" },
      });
    case "tool_execution_finished":
      return applyToolExecutionFinished(state, event);
    case "agent_run_settled": {
      const settledState = { ...state, isAgentWorking: false };
      return event.wasInterrupted
        ? appendEntry(settledState, { kind: "agent_interrupted", key: `event:${sequence}` })
        : settledState;
    }
    case "agent_failed":
      return appendEntry(
        { ...state, isAgentWorking: false },
        { kind: "agent_failed", key: `event:${sequence}`, errorMessage: event.errorMessage },
      );
  }
}

function applyToolExecutionFinished(
  state: ThreadState,
  event: Extract<RecordedThreadEvent["event"], { type: "tool_execution_finished" }>,
): ThreadState {
  const key = toolEntryKey(event.toolCallId);
  const startedEntry = state.entries.find((entry) => entry.key === key);
  const finishedEntry: ToolExecutionEntry = {
    kind: "tool_execution",
    key,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    // A finish without a start (which the protocol does not produce) still
    // shows its output; only the arguments are unknown.
    arguments: startedEntry?.kind === "tool_execution" ? startedEntry.arguments : {},
    outcome: {
      status: event.isError ? "errored" : "finished",
      output: event.output,
      durationInMilliseconds: event.durationInMilliseconds,
    },
  };
  return replaceOrAppendEntry(state, finishedEntry);
}

/**
 * Adds streamed text to the message it belongs to. Text for a message whose
 * completed event has already been applied is ignored: the recorded message
 * is the authority and has replaced its fragments.
 */
export function applyAssistantTextFragment(
  state: ThreadState,
  fragment: AssistantTextFragment,
): ThreadState {
  const key = assistantEntryKey(fragment.messageId);
  const existingEntry = state.entries.find((entry) => entry.key === key);
  if (existingEntry !== undefined && existingEntry.kind !== "streaming_assistant_message") {
    return state;
  }
  const blocks = appendFragmentToBlocks(existingEntry?.blocks ?? [], fragment);
  return replaceOrAppendEntry(state, {
    kind: "streaming_assistant_message",
    key,
    messageId: fragment.messageId,
    blocks,
  });
}

function appendFragmentToBlocks(
  blocks: StreamedContentBlock[],
  fragment: AssistantTextFragment,
): StreamedContentBlock[] {
  const existingBlock = blocks.find(
    (block) => block.contentBlockIndex === fragment.contentBlockIndex,
  );
  if (existingBlock === undefined) {
    const newBlock = {
      contentBlockIndex: fragment.contentBlockIndex,
      contentBlockType: fragment.contentBlockType,
      text: fragment.appendedText,
    };
    return [...blocks, newBlock].sort(
      (first, second) => first.contentBlockIndex - second.contentBlockIndex,
    );
  }
  return blocks.map((block) =>
    block === existingBlock ? { ...block, text: block.text + fragment.appendedText } : block,
  );
}

/**
 * While disconnected the page cannot know whether the supervisor is still
 * there, so it stops claiming it is; the status arrives again after the
 * replay on reconnect.
 */
function applyConnectionChange(state: ThreadState, connection: ConnectionState): ThreadState {
  const isSupervisorConnected = connection.name === "connected" && state.isSupervisorConnected;
  return { ...state, connection, isSupervisorConnected };
}

function appendEntry(state: ThreadState, entry: ConversationEntry): ThreadState {
  return { ...state, entries: [...state.entries, entry] };
}

/** Replaces the entry with the same key where it stands, so a message keeps its place as it completes. */
function replaceOrAppendEntry(state: ThreadState, entry: ConversationEntry): ThreadState {
  const index = state.entries.findIndex((existingEntry) => existingEntry.key === entry.key);
  if (index === -1) {
    return appendEntry(state, entry);
  }
  return { ...state, entries: state.entries.with(index, entry) };
}

function assistantEntryKey(messageId: string): string {
  return `assistant:${messageId}`;
}

function toolEntryKey(toolCallId: string): string {
  return `tool:${toolCallId}`;
}
