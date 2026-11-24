import { closeCodes, type DesktopUnavailableReason } from "@barrack/protocol";
import type { AccessTokenLookup } from "../authentication/sign-in-service";
import type { StopConsequence } from "../connection/connection-machine";
import { reconnectDelayInMilliseconds } from "../connection/reconnect-delay";

/**
 * The rules for one thread's desktop viewer, as a pure function of what
 * happened, so they can be tested without sockets or noVNC.
 * `DesktopViewerConnection` feeds it events and carries out its effects.
 * The handshake it follows is in `packages/protocol/src/desktop-messages.ts`.
 *
 * - `idle`: not wanted now, because the sandbox is not running, the tab is
 *   hidden, or the panel is closed; nothing is open. Opening a viewer never
 *   wakes a sandbox: the page offers to.
 * - `obtaining_access_token`, `opening`, `authenticating`: as for the
 *   thread's connection, the token first, then the socket, then the token as
 *   its first message, then waiting for `desktop_ready`.
 * - `streaming`: noVNC has the socket; newer tokens and control requests
 *   still go on it, as text.
 * - `waiting`: about to try again.
 * - `unavailable`: the control plane said trying again will not help (no
 *   desktop, too many viewers) until the conditions change.
 * - `stopped`: closed for good, as the thread's connection would be.
 */
export type DesktopViewerPhase =
  | { name: "idle" }
  | { name: "obtaining_access_token" }
  | { name: "opening"; accessToken: string }
  | { name: "authenticating" }
  | { name: "streaming"; viewerId: string }
  | { name: "waiting"; explanation: string | undefined }
  | { name: "unavailable"; reason: DesktopUnavailableReason; explanation: string }
  | { name: "stopped"; reason: string };

/** What decides whether the viewer should be open at all. */
export type DesktopViewerConditions = {
  isSandboxRunning: boolean;
  isPageVisible: boolean;
  isPanelOpen: boolean;
};

export type DesktopViewerState = {
  phase: DesktopViewerPhase;
  conditions: DesktopViewerConditions;
  failedAttemptCount: number;
  mustRefreshAccessToken: boolean;
  /** Why the control plane said the desktop was unavailable, before closing the socket. */
  lastUnavailability: { reason: DesktopUnavailableReason; explanation: string } | undefined;
};

export type DesktopViewerEvent =
  | { type: "conditions_changed"; conditions: DesktopViewerConditions }
  | { type: "retry_due" }
  | { type: "access_token_obtained"; lookup: AccessTokenLookup }
  | { type: "socket_opened" }
  | { type: "ready_received"; viewerId: string }
  | { type: "unavailable_received"; reason: DesktopUnavailableReason; explanation: string }
  | { type: "socket_closed"; closeCode: number }
  | { type: "access_token_refreshed"; accessToken: string }
  | { type: "control_requested"; take: boolean };

export type DesktopViewerEffect =
  | { type: "obtain_access_token"; refreshFirst: boolean }
  | { type: "open_socket" }
  | { type: "send_authentication"; accessToken: string }
  /** Hand the open socket to noVNC; it must happen before anything else is read from it. */
  | { type: "start_vnc"; viewerId: string }
  | { type: "send_control_request"; take: boolean }
  | { type: "close_socket" }
  | { type: "retry"; delayInMilliseconds: number }
  | { type: "stop"; reason: string; consequence: StopConsequence };

export type DesktopViewerTransition = {
  state: DesktopViewerState;
  effects: DesktopViewerEffect[];
};

export const initialDesktopViewerState: DesktopViewerState = {
  phase: { name: "idle" },
  conditions: { isSandboxRunning: false, isPageVisible: true, isPanelOpen: true },
  failedAttemptCount: 0,
  mustRefreshAccessToken: false,
  lastUnavailability: undefined,
};

/** Reasons a retry can fix soon; the others wait for the conditions to change. */
const passingUnavailability: ReadonlySet<DesktopUnavailableReason> = new Set([
  "sandbox_not_running",
  "sandbox_not_connected",
  "desktop_starting",
  "stream_not_opened",
]);

export function advanceDesktopViewer(
  state: DesktopViewerState,
  event: DesktopViewerEvent,
  randomFraction: () => number = Math.random,
): DesktopViewerTransition {
  if (state.phase.name === "stopped") {
    return { state, effects: [] };
  }
  switch (event.type) {
    case "conditions_changed":
      return applyConditions({ ...state, conditions: event.conditions });
    case "retry_due":
      return state.phase.name === "waiting" && isWanted(state.conditions)
        ? obtainAccessToken(state)
        : { state, effects: [] };
    case "access_token_obtained":
      return afterAccessTokenLookup(state, event.lookup, randomFraction);
    case "socket_opened":
      return authenticate(state);
    case "ready_received":
      return startStreaming(state, event.viewerId);
    case "unavailable_received":
      return {
        state: {
          ...state,
          lastUnavailability: { reason: event.reason, explanation: event.explanation },
        },
        effects: [],
      };
    case "socket_closed":
      return afterClose(state, event.closeCode, randomFraction);
    case "access_token_refreshed":
      return state.phase.name === "streaming"
        ? { state, effects: [{ type: "send_authentication", accessToken: event.accessToken }] }
        : { state, effects: [] };
    case "control_requested":
      return state.phase.name === "streaming"
        ? { state, effects: [{ type: "send_control_request", take: event.take }] }
        : { state, effects: [] };
  }
}

export function isWanted(conditions: DesktopViewerConditions): boolean {
  return conditions.isSandboxRunning && conditions.isPageVisible && conditions.isPanelOpen;
}

/**
 * Hiding the tab or closing the panel ends the stream, so a forgotten tab
 * streams nothing (and gives up control); showing it again reconnects.
 */
function applyConditions(state: DesktopViewerState): DesktopViewerTransition {
  const isActive = state.phase.name !== "idle" && state.phase.name !== "unavailable";
  if (!isWanted(state.conditions)) {
    const idle = { ...state, phase: { name: "idle" } as const, failedAttemptCount: 0 };
    return { state: idle, effects: isActive ? [{ type: "close_socket" }] : [] };
  }
  if (isActive) {
    return { state, effects: [] };
  }
  return obtainAccessToken({ ...state, lastUnavailability: undefined });
}

function obtainAccessToken(state: DesktopViewerState): DesktopViewerTransition {
  return {
    state: { ...state, phase: { name: "obtaining_access_token" }, lastUnavailability: undefined },
    effects: [{ type: "obtain_access_token", refreshFirst: state.mustRefreshAccessToken }],
  };
}

function afterAccessTokenLookup(
  state: DesktopViewerState,
  lookup: AccessTokenLookup,
  randomFraction: () => number,
): DesktopViewerTransition {
  if (state.phase.name !== "obtaining_access_token") {
    return { state, effects: [] };
  }
  switch (lookup.status) {
    case "available":
      return {
        state: {
          ...state,
          phase: { name: "opening", accessToken: lookup.accessToken },
          mustRefreshAccessToken: false,
        },
        effects: [{ type: "open_socket" }],
      };
    case "signed_out":
      return stop(state, "You are signed out. Sign in again.", "sign_in_required");
    case "unavailable":
      return retryAfterFailure(state, randomFraction, undefined);
  }
}

function authenticate(state: DesktopViewerState): DesktopViewerTransition {
  if (state.phase.name !== "opening") {
    return { state, effects: [] };
  }
  return {
    state: { ...state, phase: { name: "authenticating" } },
    effects: [{ type: "send_authentication", accessToken: state.phase.accessToken }],
  };
}

function startStreaming(state: DesktopViewerState, viewerId: string): DesktopViewerTransition {
  if (state.phase.name !== "authenticating") {
    return { state, effects: [] };
  }
  return {
    state: { ...state, phase: { name: "streaming", viewerId }, failedAttemptCount: 0 },
    effects: [{ type: "start_vnc", viewerId }],
  };
}

function afterClose(
  state: DesktopViewerState,
  closeCode: number,
  randomFraction: () => number,
): DesktopViewerTransition {
  if (state.phase.name === "idle" || state.phase.name === "unavailable") {
    return { state, effects: [] };
  }
  switch (closeCode) {
    case closeCodes.desktopUnavailable:
      return afterUnavailable(state, randomFraction);
    case closeCodes.notAuthenticated:
      return stop(state, "Your sign-in was not accepted. Sign in again.", "sign_in_required");
    case closeCodes.userNotAllowed:
      return stop(state, "This installation of Barrack does not let you use it.", "not_allowed");
    case closeCodes.threadNotFound:
      return stop(state, "There is no such thread.", "none");
    case closeCodes.invalidMessage:
      return stop(state, "The desktop stopped because of an error. Reload the page.", "none");
    case closeCodes.accessTokenExpired:
      return {
        state: {
          ...state,
          phase: { name: "waiting", explanation: undefined },
          mustRefreshAccessToken: true,
        },
        effects: [{ type: "retry", delayInMilliseconds: 0 }],
      };
    case closeCodes.desktopStreamEnded:
      return retryAfterFailure(state, randomFraction, "The desktop stream ended; reconnecting.");
    default:
      return retryAfterFailure(state, randomFraction, undefined);
  }
}

function afterUnavailable(
  state: DesktopViewerState,
  randomFraction: () => number,
): DesktopViewerTransition {
  const unavailability = state.lastUnavailability ?? {
    reason: "stream_not_opened" as const,
    explanation: "The desktop is not available right now.",
  };
  if (passingUnavailability.has(unavailability.reason)) {
    return retryAfterFailure(state, randomFraction, unavailability.explanation);
  }
  return { state: { ...state, phase: { name: "unavailable", ...unavailability } }, effects: [] };
}

function retryAfterFailure(
  state: DesktopViewerState,
  randomFraction: () => number,
  explanation: string | undefined,
): DesktopViewerTransition {
  return {
    state: {
      ...state,
      phase: { name: "waiting", explanation },
      failedAttemptCount: state.failedAttemptCount + 1,
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
  state: DesktopViewerState,
  reason: string,
  consequence: StopConsequence,
): DesktopViewerTransition {
  return {
    state: { ...state, phase: { name: "stopped", reason } },
    effects: [{ type: "close_socket" }, { type: "stop", reason, consequence }],
  };
}
