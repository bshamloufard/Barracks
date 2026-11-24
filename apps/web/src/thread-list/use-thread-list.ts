import type { ThreadSummary } from "@barrack/protocol";
import { useCallback, useEffect, useReducer } from "react";
import type { NewThreadChoices } from "../api/threads-api";
import { useSession } from "../authentication/session-context";
import { threadPageAddress } from "../page-address";
import { isSandboxChanging } from "../presentation/describe-sandbox";
import {
  initialThreadListState,
  reduceThreadListState,
  type ThreadListState,
} from "./thread-list-state";

export type ThreadListControls = {
  state: ThreadListState;
  reloadThreads: () => void;
  /** Creates a thread, from the repository if one is given, and once it exists opens its page. */
  createThreadAndOpenIt: (choices: NewThreadChoices) => void;
};

/** While a listed sandbox is changing state, how often the list is fetched again. */
const changingRefreshIntervalInMilliseconds = 2_000;

/** Otherwise, how often: enough to see sandboxes stop for being idle, and agents start and finish. */
const settledRefreshIntervalInMilliseconds = 15_000;

/**
 * Loads the thread list once the calling component mounts, and keeps it
 * fresh while it stays mounted. A refresh that fails leaves the list as it
 * was, and the next one tries again.
 */
export function useThreadList(): ThreadListControls {
  const [state, dispatch] = useReducer(reduceThreadListState, initialThreadListState);
  const { threadsApi } = useSession();

  const reloadThreads = useCallback(() => {
    dispatch({ type: "list_requested" });
    threadsApi.listThreads().then(
      (threads) => dispatch({ type: "list_loaded", threads }),
      (error: unknown) => dispatch({ type: "list_failed", reason: describeError(error) }),
    );
  }, [threadsApi]);

  useEffect(reloadThreads, [reloadThreads]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let isUnmounted = false;
    const refreshIn = (delayInMilliseconds: number) => {
      if (!isUnmounted) {
        timer = setTimeout(refresh, delayInMilliseconds);
      }
    };
    const refresh = () => {
      threadsApi.listThreads().then(
        (threads) => {
          dispatch({ type: "list_loaded", threads });
          refreshIn(refreshIntervalFor(threads));
        },
        (error: unknown) => {
          console.error(error);
          refreshIn(settledRefreshIntervalInMilliseconds);
        },
      );
    };
    refreshIn(changingRefreshIntervalInMilliseconds);
    return () => {
      isUnmounted = true;
      clearTimeout(timer);
    };
  }, [threadsApi]);

  const createThreadAndOpenIt = useCallback(
    (choices: NewThreadChoices) => {
      dispatch({ type: "creation_started" });
      threadsApi.createThread(choices).then(
        (thread) => window.location.assign(threadPageAddress(thread.threadId)),
        (error: unknown) => dispatch({ type: "creation_failed", reason: describeError(error) }),
      );
    },
    [threadsApi],
  );

  return { state, reloadThreads, createThreadAndOpenIt };
}

function refreshIntervalFor(threads: ThreadSummary[]): number {
  return threads.some((thread) => isSandboxChanging(thread.sandbox))
    ? changingRefreshIntervalInMilliseconds
    : settledRefreshIntervalInMilliseconds;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
