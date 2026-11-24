import { useCallback, useEffect, useReducer } from "react";
import { createThread, listThreads } from "../api/threads-api";
import { threadPageAddress } from "../page-address";
import {
  initialThreadListState,
  reduceThreadListState,
  type ThreadListState,
} from "./thread-list-state";

export type ThreadListControls = {
  state: ThreadListState;
  reloadThreads: () => void;
  /** Creates a thread and, once it exists, opens its page. */
  createThreadAndOpenIt: () => void;
};

/** Loads the thread list once the calling component mounts. */
export function useThreadList(): ThreadListControls {
  const [state, dispatch] = useReducer(reduceThreadListState, initialThreadListState);

  const reloadThreads = useCallback(() => {
    dispatch({ type: "list_requested" });
    listThreads().then(
      (threads) => dispatch({ type: "list_loaded", threads }),
      (error: unknown) => dispatch({ type: "list_failed", reason: describeError(error) }),
    );
  }, []);

  useEffect(reloadThreads, [reloadThreads]);

  const createThreadAndOpenIt = useCallback(() => {
    dispatch({ type: "creation_started" });
    createThread().then(
      (thread) => window.location.assign(threadPageAddress(thread.threadId)),
      (error: unknown) => dispatch({ type: "creation_failed", reason: describeError(error) }),
    );
  }, []);

  return { state, reloadThreads, createThreadAndOpenIt };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
