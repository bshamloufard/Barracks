import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ThreadConnection } from "./connection/thread-connection";
import { ThreadRecordPoller } from "./connection/thread-record-poller";
import type { ThreadState } from "./thread-state/thread-state";
import { ThreadStore } from "./thread-state/thread-store";

export type ThreadControls = {
  state: ThreadState;
  sendUserMessage: (text: string) => void;
  interruptAgent: () => void;
  dismissRejection: () => void;
};

/**
 * Follows a thread for as long as the calling component is mounted: its
 * record, until its sandbox is settled, and, once the record shows the
 * thread exists, its live connection.
 */
export function useThread(threadId: string): ThreadControls {
  const [store] = useState(() => new ThreadStore());
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const connectionReference = useRef<ThreadConnection | undefined>(undefined);

  useEffect(() => {
    const connection = new ThreadConnection(threadId, store);
    connectionReference.current = connection;
    const recordPoller = new ThreadRecordPoller(threadId, store, () => connection.start());
    recordPoller.start();
    return () => {
      recordPoller.stop();
      connection.stop();
    };
  }, [threadId, store]);

  const sendUserMessage = useCallback((text: string) => {
    connectionReference.current?.sendUserMessage(text);
  }, []);
  const interruptAgent = useCallback(() => {
    connectionReference.current?.interruptAgent();
  }, []);
  const dismissRejection = useCallback(() => {
    store.dispatch({ type: "rejection_dismissed" });
  }, [store]);

  return { state, sendUserMessage, interruptAgent, dismissRejection };
}
