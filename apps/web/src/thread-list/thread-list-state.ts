import type { ThreadSummary } from "@barrack/protocol";

/**
 * Everything the thread list page shows, changed only by this pure reducer,
 * like a thread's own state.
 */
export type ThreadListState = {
  list:
    | { name: "loading" }
    | { name: "loaded"; threads: ThreadSummary[] }
    | { name: "failed"; reason: string };
  isCreatingThread: boolean;
  /** Why the last attempt to create a thread failed, until the next attempt. */
  creationFailureReason: string | undefined;
};

export type ThreadListAction =
  | { type: "list_requested" }
  | { type: "list_loaded"; threads: ThreadSummary[] }
  | { type: "list_failed"; reason: string }
  | { type: "creation_started" }
  | { type: "creation_failed"; reason: string };

export const initialThreadListState: ThreadListState = {
  list: { name: "loading" },
  isCreatingThread: false,
  creationFailureReason: undefined,
};

export function reduceThreadListState(
  state: ThreadListState,
  action: ThreadListAction,
): ThreadListState {
  switch (action.type) {
    case "list_requested":
      return { ...state, list: { name: "loading" } };
    case "list_loaded":
      return { ...state, list: { name: "loaded", threads: action.threads } };
    case "list_failed":
      return { ...state, list: { name: "failed", reason: action.reason } };
    case "creation_started":
      return { ...state, isCreatingThread: true, creationFailureReason: undefined };
    case "creation_failed":
      return { ...state, isCreatingThread: false, creationFailureReason: action.reason };
  }
}
