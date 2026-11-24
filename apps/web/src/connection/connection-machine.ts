import { closeCodes } from "@barrack/protocol";
import { reconnectDelayInMilliseconds } from "./reconnect-delay";

/**
 * The rules for one thread's connection, as a pure function of what
 * happened, so they can be tested without sockets. `ThreadConnection` feeds
 * it events and carries out the effects it returns.
 *
 * - `opening`: the socket is being opened.
 * - `authenticating`: open, the token sent, waiting for the replay
 *   announcement, before which the client may send nothing else.
 * - `live`: authenticated; every newer token is sent at once.
 * - `waiting`: closed, and about to reconnect.
 * - `stopped`: closed for good, because reconnecting would not help.
 */
export type ConnectionPhase = "opening" | "authenticating" | "live" | "waiting" | "stopped";

export type ConnectionMachineState = {
  phase: ConnectionPhase;
  /** Connections in a row that ended before authenticating, which sets the backoff. */
  failedAttemptCount: number;
};

export type ConnectionEvent =
  /** The socket opened; the token is the current one, or undefined if signed out. */
  | { type: "socket_opened"; accessToken: string | undefined }
  | { type: "first_message_received" }
  | { type: "access_token_refreshed"; accessToken: string }
  | { type: "socket_closed"; closeCode: number }
  | { type: "stop_requested" };

/** Why the page stopped reconnecting, beyond what it tells the user. */
export type StopConsequence = "sign_in_required" | "not_allowed" | "thread_not_found" | "none";

export type ConnectionEffect =
  | { type: "send_authentication"; accessToken: string }
  | { type: "close_socket" }
  | { type: "reconnect"; delayInMilliseconds: number; refreshAccessTokenFirst: boolean }
  | { type: "stop"; reason: string; consequence: StopConsequence };

export type ConnectionTransition = {
  state: ConnectionMachineState;
  effects: ConnectionEffect[];
};

export const initialConnectionMachineState: ConnectionMachineState = {
  phase: "opening",
  failedAttemptCount: 0,
};

export function advanceConnection(
  state: ConnectionMachineState,
  event: ConnectionEvent,
  randomFraction: () => number = Math.random,
): ConnectionTransition {
  if (state.phase === "stopped") {
    return { state, effects: [] };
  }
  switch (event.type) {
    case "socket_opened":
      return authenticate(state, event.accessToken);
    case "first_message_received":
      return { state: { phase: "live", failedAttemptCount: 0 }, effects: [] };
    case "access_token_refreshed":
      return state.phase === "live"
        ? { state, effects: [{ type: "send_authentication", accessToken: event.accessToken }] }
        : { state, effects: [] };
    case "socket_closed":
      return afterClose(state, event.closeCode, randomFraction);
    case "stop_requested":
      return { state: { ...state, phase: "stopped" }, effects: [{ type: "close_socket" }] };
  }
}

function authenticate(
  state: ConnectionMachineState,
  accessToken: string | undefined,
): ConnectionTransition {
  if (accessToken === undefined) {
    return stop(state, "You are signed out. Sign in again.", "sign_in_required", [
      { type: "close_socket" },
    ]);
  }
  return {
    state: { ...state, phase: "authenticating" },
    effects: [{ type: "send_authentication", accessToken }],
  };
}

/**
 * An expired token is the normal end of a long-open connection: the page
 * refreshes it and reconnects at once, picking up where it left off. Codes
 * that say reconnecting cannot help stop it; anything else (a restart, a
 * network failure, a slow reader) reconnects after a growing delay.
 */
function afterClose(
  state: ConnectionMachineState,
  closeCode: number,
  randomFraction: () => number,
): ConnectionTransition {
  switch (closeCode) {
    case closeCodes.invalidMessage:
      return stop(
        state,
        "The control plane refused a message from this page as invalid. Reload the page.",
        "none",
      );
    case closeCodes.notAuthenticated:
      return stop(state, "Your sign-in was not accepted. Sign in again.", "sign_in_required");
    case closeCodes.userNotAllowed:
      return stop(state, "This installation of Barrack does not let you use it.", "not_allowed");
    case closeCodes.threadNotFound:
      return stop(state, "There is no such thread.", "thread_not_found");
    case closeCodes.accessTokenExpired:
      return reconnect(state, true, randomFraction);
    default:
      return reconnect(state, false, randomFraction);
  }
}

function reconnect(
  state: ConnectionMachineState,
  refreshAccessTokenFirst: boolean,
  randomFraction: () => number,
): ConnectionTransition {
  // A token that expired on a live connection is no failure; one refused
  // straight after refreshing would be, so it backs off like any other.
  const isRoutineExpiry = refreshAccessTokenFirst && state.phase === "live";
  const delayInMilliseconds = isRoutineExpiry
    ? 0
    : reconnectDelayInMilliseconds(state.failedAttemptCount, randomFraction);
  return {
    state: {
      phase: "waiting",
      failedAttemptCount: isRoutineExpiry ? 0 : state.failedAttemptCount + 1,
    },
    effects: [{ type: "reconnect", delayInMilliseconds, refreshAccessTokenFirst }],
  };
}

function stop(
  state: ConnectionMachineState,
  reason: string,
  consequence: StopConsequence,
  effectsBefore: ConnectionEffect[] = [],
): ConnectionTransition {
  return {
    state: { ...state, phase: "stopped" },
    effects: [...effectsBefore, { type: "stop", reason, consequence }],
  };
}

/** Phase for the next socket, once the delay a `reconnect` effect asked for has passed. */
export function reopenConnection(state: ConnectionMachineState): ConnectionMachineState {
  return state.phase === "stopped" ? state : { ...state, phase: "opening" };
}
