import type {
  AssistantContentBlock,
  AssistantMessageEndReason,
  AssistantTextFragment,
  ControlPlaneToClientMessage,
  RecordedThreadEvent,
  ReplayAnnouncement,
  RepositoryEvent,
  ThreadSummary,
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
  /** Its place in the thread, which says whether the agent has been handed it yet. */
  sequence: number;
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

/** Something that happened to the thread's repository: cloning it, or publishing its branch. */
export type RepositoryEventEntry = {
  kind: "repository_event";
  key: string;
  event: RepositoryEvent;
};

export type ConversationEntry =
  | UserMessageEntry
  | StreamingAssistantMessageEntry
  | AssistantMessageEntry
  | ToolExecutionEntry
  | AgentFailedEntry
  | AgentInterruptedEntry
  | RepositoryEventEntry;

export type ConnectionState =
  | { name: "connecting" }
  | { name: "connected" }
  | { name: "reconnecting" }
  /** The page has given up reconnecting, because doing so would not help. */
  | { name: "stopped"; reason: string };

/** What the control plane's record of the thread says, fetched over HTTP. */
export type ThreadRecordState =
  | { name: "loading" }
  | { name: "not_found" }
  | { name: "found"; thread: ThreadSummary };

export type LifecycleAction = "stop" | "resume" | "delete";

/**
 * Where the user's own request to stop, resume or delete the thread is. A
 * deletion is confirmed first, since it cannot be undone.
 */
export type LifecycleRequestState =
  | { name: "none" }
  | { name: "confirming_delete" }
  | { name: "sending"; action: LifecycleAction };

export type ThreadState = {
  record: ThreadRecordState;
  /** The sequence of the newest thread event applied, or 0 for none. Sent when reconnecting. */
  lastSeenSequence: number;
  entries: ConversationEntry[];
  /** A run has started and has not yet settled or failed. */
  isAgentWorking: boolean;
  isSupervisorConnected: boolean;
  /**
   * User messages up to this sequence have reached the agent; later ones are
   * waiting for it. Unknown until the control plane first says, after the
   * replay, so that a page catching up does not show every replayed message
   * as waiting until then.
   */
  userMessagesDeliveredThroughSequence: number | undefined;
  /**
   * Whether this page has seen the supervisor connected since it opened.
   * Until it has, a sandbox that exists may still be starting its supervisor.
   */
  hasSeenSupervisorConnected: boolean;
  connection: ConnectionState;
  /** Why the control plane refused the last thing this page sent, until the user dismisses it. */
  rejectionReason: string | undefined;
  lifecycleRequest: LifecycleRequestState;
};

export type ThreadAction =
  | { type: "thread_record_loaded"; thread: ThreadSummary }
  | { type: "thread_record_missing" }
  | { type: "message_received"; message: ControlPlaneToClientMessage }
  | { type: "connection_changed"; connection: ConnectionState }
  | { type: "rejection_dismissed" }
  | { type: "delete_confirmation_requested" }
  | { type: "delete_confirmation_cancelled" }
  | { type: "lifecycle_request_sent"; action: LifecycleAction }
  | { type: "lifecycle_request_answered"; thread: ThreadSummary }
  | { type: "lifecycle_request_failed"; reason: string };

export const initialThreadState: ThreadState = {
  record: { name: "loading" },
  lastSeenSequence: 0,
  entries: [],
  isAgentWorking: false,
  isSupervisorConnected: false,
  userMessagesDeliveredThroughSequence: undefined,
  hasSeenSupervisorConnected: false,
  connection: { name: "connecting" },
  rejectionReason: undefined,
  lifecycleRequest: { name: "none" },
};

export function reduceThreadState(state: ThreadState, action: ThreadAction): ThreadState {
  switch (action.type) {
    case "thread_record_loaded":
      return applyThreadRecord(state, action.thread);
    case "thread_record_missing":
      return { ...state, record: { name: "not_found" } };
    case "message_received":
      return applyControlPlaneMessage(state, action.message);
    case "connection_changed":
      return applyConnectionChange(state, action.connection);
    case "rejection_dismissed":
      return { ...state, rejectionReason: undefined };
    case "delete_confirmation_requested":
      return { ...state, lifecycleRequest: { name: "confirming_delete" } };
    case "delete_confirmation_cancelled":
      return { ...state, lifecycleRequest: { name: "none" } };
    case "lifecycle_request_sent":
      return { ...state, lifecycleRequest: { name: "sending", action: action.action } };
    case "lifecycle_request_answered":
      return { ...applyThreadRecord(state, action.thread), lifecycleRequest: { name: "none" } };
    case "lifecycle_request_failed":
      return { ...state, lifecycleRequest: { name: "none" }, rejectionReason: action.reason };
  }
}

/**
 * Until a sandbox that is not running has run again, this page has not seen
 * its new supervisor, which is starting rather than gone.
 */
function applyThreadRecord(state: ThreadState, thread: ThreadSummary): ThreadState {
  return {
    ...state,
    record: { name: "found", thread },
    hasSeenSupervisorConnected:
      thread.sandbox.state === "running"
        ? state.hasSeenSupervisorConnected
        : state.isSupervisorConnected,
  };
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
      return {
        ...state,
        isSupervisorConnected: message.isSupervisorConnected,
        hasSeenSupervisorConnected:
          state.hasSeenSupervisorConnected || message.isSupervisorConnected,
      };
    case "user_message_delivery_status":
      return { ...state, userMessagesDeliveredThroughSequence: message.deliveredThroughSequence };
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
      userMessagesDeliveredThroughSequence: undefined,
    };
  }
  return discardStreamedText(state);
}

/** Whether the agent has yet to be handed this message, as far as the page knows. */
export function isWaitingForAgent(
  userMessagesDeliveredThroughSequence: number | undefined,
  entry: UserMessageEntry,
): boolean {
  return (
    userMessagesDeliveredThroughSequence !== undefined &&
    entry.sequence > userMessagesDeliveredThroughSequence
  );
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
        sequence,
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
      const settledState = endRun(state);
      return event.wasInterrupted
        ? appendEntry(settledState, { kind: "agent_interrupted", key: `event:${sequence}` })
        : settledState;
    }
    case "agent_failed":
      return appendEntry(endRun(state), {
        kind: "agent_failed",
        key: `event:${sequence}`,
        errorMessage: event.errorMessage,
      });
    case "repository_clone_started":
    case "repository_cloned":
    case "repository_clone_failed":
    case "repository_published":
    case "repository_publication_failed":
      return appendEntry(state, { kind: "repository_event", key: `event:${sequence}`, event });
  }
}

/** A run that settles or fails takes with it any streamed text it never completed. */
function endRun(state: ThreadState): ThreadState {
  return { ...discardStreamedText(state), isAgentWorking: false };
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
 *
 * Streamed text is shown only for the message currently being produced, by
 * the same rule the control plane uses for the text it sends to clients that
 * join mid-message (`InProgressAssistantText` in
 * apps/control-plane/src/thread-relay/in-progress-assistant-text.ts), so a
 * page that watched all along shows what a page that reconnects shows: text
 * that was never completed is discarded when another message starts
 * streaming and when the run settles or fails.
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
  return replaceOrAppendEntry(discardStreamedText(state, key), {
    kind: "streaming_assistant_message",
    key,
    messageId: fragment.messageId,
    blocks,
  });
}

/** Drops every streaming entry, except the one with `keptKey` if given. */
function discardStreamedText(state: ThreadState, keptKey?: string): ThreadState {
  const entries = state.entries.filter(
    (entry) => entry.kind !== "streaming_assistant_message" || entry.key === keptKey,
  );
  return { ...state, entries };
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
