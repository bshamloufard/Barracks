import type { ThreadSummary } from "@barrack/protocol";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSession } from "./authentication/session-context";
import { ThreadConnection } from "./connection/thread-connection";
import { ThreadRecordPoller } from "./connection/thread-record-poller";
import { threadListAddress } from "./page-address";
import type { LifecycleAction, ThreadState } from "./thread-state/thread-state";
import { ThreadStore } from "./thread-state/thread-store";

export type ThreadControls = {
  state: ThreadState;
  sendUserMessage: (text: string) => void;
  interruptAgent: () => void;
  dismissRejection: () => void;
  stopThread: () => void;
  resumeThread: () => void;
  /** Asks the user to confirm first; `confirmDeletion` then deletes. */
  requestDeletion: () => void;
  confirmDeletion: () => void;
  cancelDeletion: () => void;
};

/**
 * Follows a thread for as long as the calling component is mounted: its
 * record, which says what its sandbox is doing, and, once the record shows
 * the thread exists, its live connection.
 */
export function useThread(threadId: string): ThreadControls {
  const [store] = useState(() => new ThreadStore());
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const connectionReference = useRef<ThreadConnection | undefined>(undefined);
  const session = useSession();

  useEffect(() => {
    const connection = new ThreadConnection(threadId, store, session);
    connectionReference.current = connection;
    const recordPoller = new ThreadRecordPoller(threadId, store, session.threadsApi, () =>
      connection.start(),
    );
    const stopRefreshingOnChanges = refreshRecordWhenItLikelyChanged(store, recordPoller);
    recordPoller.start();
    return () => {
      stopRefreshingOnChanges();
      recordPoller.stop();
      connection.stop();
    };
  }, [threadId, store, session]);

  const sendUserMessage = useCallback((text: string) => {
    connectionReference.current?.sendUserMessage(text);
  }, []);
  const interruptAgent = useCallback(() => {
    connectionReference.current?.interruptAgent();
  }, []);
  const dismissRejection = useCallback(() => {
    store.dispatch({ type: "rejection_dismissed" });
  }, [store]);

  const requestLifecycleChange = useCallback(
    (action: LifecycleAction, send: () => Promise<ThreadSummary>) => {
      store.dispatch({ type: "lifecycle_request_sent", action });
      send().then(
        (thread) => {
          store.dispatch({ type: "lifecycle_request_answered", thread });
          if (action === "delete") {
            window.location.assign(threadListAddress);
          }
        },
        (error: unknown) =>
          store.dispatch({
            type: "lifecycle_request_failed",
            reason: error instanceof Error ? error.message : String(error),
          }),
      );
    },
    [store],
  );
  const { threadsApi } = session;
  const stopThread = useCallback(
    () => requestLifecycleChange("stop", () => threadsApi.stopThread(threadId)),
    [requestLifecycleChange, threadsApi, threadId],
  );
  const resumeThread = useCallback(
    () => requestLifecycleChange("resume", () => threadsApi.resumeThread(threadId)),
    [requestLifecycleChange, threadsApi, threadId],
  );
  const confirmDeletion = useCallback(
    () => requestLifecycleChange("delete", () => threadsApi.deleteThread(threadId)),
    [requestLifecycleChange, threadsApi, threadId],
  );
  const requestDeletion = useCallback(() => {
    store.dispatch({ type: "delete_confirmation_requested" });
  }, [store]);
  const cancelDeletion = useCallback(() => {
    store.dispatch({ type: "delete_confirmation_cancelled" });
  }, [store]);

  return {
    state,
    sendUserMessage,
    interruptAgent,
    dismissRejection,
    stopThread,
    resumeThread,
    requestDeletion,
    confirmDeletion,
    cancelDeletion,
  };
}

/**
 * The supervisor connecting or leaving means the sandbox started or
 * stopped, and a new user message may have woken it, so the record is
 * fetched again at once rather than when next due. Returns how to stop.
 */
function refreshRecordWhenItLikelyChanged(
  store: ThreadStore,
  recordPoller: ThreadRecordPoller,
): () => void {
  let previous = store.getState();
  return store.subscribe(() => {
    const current = store.getState();
    const userMessageCount = (state: ThreadState) =>
      state.entries.filter((entry) => entry.kind === "user_message").length;
    if (
      current.isSupervisorConnected !== previous.isSupervisorConnected ||
      userMessageCount(current) > userMessageCount(previous)
    ) {
      recordPoller.refreshNow();
    }
    previous = current;
  });
}
