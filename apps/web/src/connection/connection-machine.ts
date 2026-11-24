import { closeCodes } from "@barrack/protocol";
import type { AccessTokenLookup } from "../authentication/sign-in-service";
import { reconnectDelayInMilliseconds } from "./reconnect-delay";

/**
 * The rules for one thread's connection, as a pure function of what
 * happened, so they can be tested without sockets. `ThreadConnection` feeds
 * it events and carries out the effects it returns.
 *
 * - `obtaining_access_token`: asking the sign-in service for a token, which
 *   may mean refreshing it. This comes before the socket, because the
 *   control plane allows only a few seconds from the upgrade to the first
 *   message, and a refresh over a slow network can take longer.
 * - `opening`: the socket is being opened, with the token in hand.
 * - `authenticating`: open, the token sent, waiting for the replay
 *   announcement, before which the client may send nothing else.
 * - `live`: authenticated; every newer token is sent at once.
 * - `waiting`: about to try again.
 * - `stopped`: closed for good, because trying again would not help.
 */
export type ConnectionPhase =
  | "obtaining_access_token"
  | "opening"
  | "authenticating"
  | "live"
  | "waiting"
  | "stopped";

export type ConnectionMachineState = {
  phase: ConnectionPhase;
  /** Attempts in a row that ended before authenticating, which sets the backoff. */
  failedAttemptCount: number;
  /** The control plane said the last token expired, so the next one must be a refreshed one. */
  mustRefreshAccessToken: boolean;
  /** While `opening`, the token the socket will authenticate with. */
  accessToken: string | undefined;
};

export type ConnectionEvent =
  /** The first attempt, or the next once a `retry` effect's delay has passed. */
  | { type: "attempt_started" }
  | { type: "access_token_obtained"; lookup: AccessTokenLookup }
  | { type: "socket_opened" }
  | { type: "first_message_received" }
  | { type: "access_token_refreshed"; accessToken: string }
  | { type: "socket_closed"; closeCode: number }
  | { type: "stop_requested" };

/** Why the page stopped trying, beyond what it tells the user. */
export type StopConsequence = "sign_in_required" | "not_allowed" | "thread_not_found" | "none";

export type ConnectionEffect =
  | { type: "obtain_access_token"; refreshFirst: boolean }
  | { type: "open_socket" }
  | { type: "send_authentication"; accessToken: string }
  | { type: "close_socket" }
  | { type: "retry"; delayInMilliseconds: number }
  | { type: "stop"; reason: string; consequence: StopConsequence };

export type ConnectionTransition = {
  state: ConnectionMachineState;
  effects: ConnectionEffect[];
};

export const initialConnectionMachineState: ConnectionMachineState = {
  phase: "waiting",
  failedAttemptCount: 0,
  mustRefreshAccessToken: false,
  accessToken: undefined,
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
    case "attempt_started":
      return obtainAccessToken(state);
    case "access_token_obtained":
      return state.phase === "obtaining_access_token"
        ? afterAccessTokenLookup(state, event.lookup, randomFraction)
        : { state, effects: [] };
    case "socket_opened":
      return authenticate(state);
    case "first_message_received":
      return { state: { ...state, phase: "live", failedAttemptCount: 0 }, effects: [] };
    case "access_token_refreshed":
      return applyRefreshedAccessToken(state, event.accessToken);
    case "socket_closed":
      return afterClose(state, event.closeCode, randomFraction);
    case "stop_requested":
      return { state: { ...state, phase: "stopped" }, effects: [{ type: "close_socket" }] };
  }
}

function obtainAccessToken(state: ConnectionMachineState): ConnectionTransition {
  return {
    state: { ...state, phase: "obtaining_access_token", accessToken: undefined },
    effects: [{ type: "obtain_access_token", refreshFirst: state.mustRefreshAccessToken }],
  };
}

/**
 * Only a definite answer that the session is gone asks the user to sign in
 * again. A token that cannot be had just now (offline, Supabase slow or
 * down) is tried again after a growing delay, and the session is kept.
 */
function afterAccessTokenLookup(
  state: ConnectionMachineState,
  lookup: AccessTokenLookup,
  randomFraction: () => number,
): ConnectionTransition {
  switch (lookup.status) {
    case "available":
      return {
        state: {
          ...state,
          phase: "opening",
          accessToken: lookup.accessToken,
          mustRefreshAccessToken: false,
        },
        effects: [{ type: "open_socket" }],
      };
    case "signed_out":
      return stop(state, "You are signed out. Sign in again.", "sign_in_required");
    case "unavailable":
      return retryAfterFailure(state, randomFraction);
  }
}

function authenticate(state: ConnectionMachineState): ConnectionTransition {
  if (state.phase !== "opening" || state.accessToken === undefined) {
    return { state, effects: [] };
  }
  return {
    state: { ...state, phase: "authenticating", accessToken: undefined },
    effects: [{ type: "send_authentication", accessToken: state.accessToken }],
  };
}

/**
 * A live connection sends a refreshed token at once. One still opening
 * authenticates with it instead of the older one. One authenticating holds
 * it back, since nothing may follow the first message before the replay; the
 * control plane closes with `accessTokenExpired` if the first one runs out.
 */
function applyRefreshedAccessToken(
  state: ConnectionMachineState,
  accessToken: string,
): ConnectionTransition {
  switch (state.phase) {
    case "live":
      return { state, effects: [{ type: "send_authentication", accessToken }] };
    case "opening":
      return { state: { ...state, accessToken }, effects: [] };
    default:
      return { state, effects: [] };
  }
}

/**
 * An expired token is the normal end of a long-open connection: the page
 * refreshes it and reconnects at once, picking up where it left off. Codes
 * that say reconnecting cannot help stop it. An authentication that timed
 * out says nothing about the sign-in, so it, like anything else (a restart,
 * a network failure, a slow reader), reconnects after a growing delay.
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
      return retryWithRefreshedAccessToken(state, randomFraction);
    default:
      return retryAfterFailure(state, randomFraction);
  }
}

/**
 * A token that expired on a live connection is no failure; one refused
 * straight after refreshing would be, so it backs off like any other.
 */
function retryWithRefreshedAccessToken(
  state: ConnectionMachineState,
  randomFraction: () => number,
): ConnectionTransition {
  const refreshing = { ...state, mustRefreshAccessToken: true };
  if (state.phase !== "live") {
    return retryAfterFailure(refreshing, randomFraction);
  }
  return {
    state: { ...refreshing, phase: "waiting", failedAttemptCount: 0 },
    effects: [{ type: "retry", delayInMilliseconds: 0 }],
  };
}

function retryAfterFailure(
  state: ConnectionMachineState,
  randomFraction: () => number,
): ConnectionTransition {
  return {
    state: {
      ...state,
      phase: "waiting",
      failedAttemptCount: state.failedAttemptCount + 1,
      accessToken: undefined,
    },
    effects: [
      {
        type: "retry",
        delayInMilliseconds: reconnectDelayInMilliseconds(state.failedAttemptCount, randomFraction),
      },
    ],
  };
}

function stop(
  state: ConnectionMachineState,
  reason: string,
  consequence: StopConsequence,
): ConnectionTransition {
  return {
    state: { ...state, phase: "stopped", accessToken: undefined },
    effects: [{ type: "stop", reason, consequence }],
  };
}
