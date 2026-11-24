import { closeCodes, type ThreadSandbox } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import { describeDesktopPanel } from "../presentation/describe-desktop";
import {
  advanceDesktopViewer,
  type DesktopViewerConditions,
  type DesktopViewerEffect,
  type DesktopViewerEvent,
  type DesktopViewerState,
  initialDesktopViewerState,
} from "./desktop-viewer-machine";

const wanted: DesktopViewerConditions = {
  isSandboxRunning: true,
  isPageVisible: true,
  isPanelOpen: true,
};
const viewerId = "0123456789abcdef0123456789abcdef";
const noJitter = () => 0;

type Run = { state: DesktopViewerState; effects: DesktopViewerEffect[] };

/** Feeds the events in order, collecting every effect. */
function run(events: DesktopViewerEvent[], from = initialDesktopViewerState): Run {
  return events.reduce<Run>(
    (soFar, event) => {
      const transition = advanceDesktopViewer(soFar.state, event, noJitter);
      return { state: transition.state, effects: [...soFar.effects, ...transition.effects] };
    },
    { state: from, effects: [] },
  );
}

const connectedEvents: DesktopViewerEvent[] = [
  { type: "conditions_changed", conditions: wanted },
  { type: "access_token_obtained", lookup: { status: "available", accessToken: "token-1" } },
  { type: "socket_opened" },
  { type: "ready_received", viewerId },
];

describe("the desktop viewer's connection", () => {
  it("obtains a token, opens the socket, authenticates first, and hands the socket to noVNC once ready", () => {
    const { state, effects } = run(connectedEvents);

    expect(effects).toEqual([
      { type: "obtain_access_token", refreshFirst: false },
      { type: "open_socket" },
      { type: "send_authentication", accessToken: "token-1" },
      { type: "start_vnc", viewerId },
    ]);
    expect(state.phase).toEqual({ name: "streaming", viewerId });
  });

  it("does nothing while the sandbox is not running, so opening it never wakes the sandbox", () => {
    const { state, effects } = run([
      { type: "conditions_changed", conditions: { ...wanted, isSandboxRunning: false } },
    ]);

    expect(effects).toEqual([]);
    expect(state.phase.name).toBe("idle");
  });

  it("closes the stream when the tab is hidden, and opens a new one when it is shown", () => {
    const streaming = run(connectedEvents).state;

    const hidden = run(
      [{ type: "conditions_changed", conditions: { ...wanted, isPageVisible: false } }],
      streaming,
    );
    const shown = run([{ type: "conditions_changed", conditions: wanted }], hidden.state);

    expect(hidden.effects).toEqual([{ type: "close_socket" }]);
    expect(hidden.state.phase.name).toBe("idle");
    expect(shown.effects).toEqual([{ type: "obtain_access_token", refreshFirst: false }]);
  });

  it("sends requests for control and newer tokens only once streaming", () => {
    const beforeReady = run(connectedEvents.slice(0, 3));
    const streaming = run(connectedEvents).state;

    expect(
      advanceDesktopViewer(beforeReady.state, { type: "control_requested", take: true }).effects,
    ).toEqual([]);
    expect(run([{ type: "control_requested", take: true }], streaming).effects).toEqual([
      { type: "send_control_request", take: true },
    ]);
    expect(
      run([{ type: "access_token_refreshed", accessToken: "token-2" }], streaming).effects,
    ).toEqual([{ type: "send_authentication", accessToken: "token-2" }]);
  });

  it("tries again after a stream that ended, or a desktop not ready yet, saying why meanwhile", () => {
    const streaming = run(connectedEvents).state;
    const authenticating = run(connectedEvents.slice(0, 3)).state;

    const ended = run(
      [{ type: "socket_closed", closeCode: closeCodes.desktopStreamEnded }],
      streaming,
    );
    const starting = run(
      [
        { type: "unavailable_received", reason: "desktop_starting", explanation: "Starting." },
        { type: "socket_closed", closeCode: closeCodes.desktopUnavailable },
      ],
      authenticating,
    );

    expect(ended.effects).toEqual([{ type: "retry", delayInMilliseconds: 250 }]);
    expect(starting.state.phase).toEqual({ name: "waiting", explanation: "Starting." });
    expect(starting.effects).toEqual([{ type: "retry", delayInMilliseconds: 250 }]);
  });

  it("stops trying when the sandbox has no desktop, until the conditions change", () => {
    const authenticating = run(connectedEvents.slice(0, 3)).state;

    const { state, effects } = run(
      [
        { type: "unavailable_received", reason: "no_desktop", explanation: "No desktop here." },
        { type: "socket_closed", closeCode: closeCodes.desktopUnavailable },
      ],
      authenticating,
    );

    expect(effects).toEqual([]);
    expect(state.phase).toEqual({
      name: "unavailable",
      reason: "no_desktop",
      explanation: "No desktop here.",
    });
  });

  it("reconnects at once with a refreshed token when its token expires", () => {
    const streaming = run(connectedEvents).state;

    const expired = run(
      [{ type: "socket_closed", closeCode: closeCodes.accessTokenExpired }, { type: "retry_due" }],
      streaming,
    );

    expect(expired.effects).toEqual([
      { type: "retry", delayInMilliseconds: 0 },
      { type: "obtain_access_token", refreshFirst: true },
    ]);
  });

  it("stops for good on a thread that is not the user's, and asks for sign-in on a refused token", () => {
    const authenticating = run(connectedEvents.slice(0, 3)).state;

    const missing = run(
      [{ type: "socket_closed", closeCode: closeCodes.threadNotFound }],
      authenticating,
    );
    const refused = run(
      [{ type: "socket_closed", closeCode: closeCodes.notAuthenticated }],
      authenticating,
    );

    expect(missing.state.phase).toEqual({ name: "stopped", reason: "There is no such thread." });
    expect(refused.effects).toContainEqual({
      type: "stop",
      reason: expect.any(String),
      consequence: "sign_in_required",
    });
  });
});

describe("the desktop panel", () => {
  const running = { state: "running" } as ThreadSandbox;
  const stopped = { state: "stopped" } as ThreadSandbox;
  const streaming = run(connectedEvents).state;

  it("offers to wake a stopped sandbox, rather than waking it", () => {
    const view = describeDesktopPanel(initialDesktopViewerState, stopped, null);

    expect(view).toMatchObject({ offersWake: true, isStreaming: false, canTakeControl: false });
    expect(view.statusText).toMatch(/stopped/);
  });

  it("offers to take control while watching, and to give it back while holding it", () => {
    expect(describeDesktopPanel(streaming, running, null)).toMatchObject({
      isStreaming: true,
      canTakeControl: true,
      hasControl: false,
    });
    expect(describeDesktopPanel(streaming, running, viewerId)).toMatchObject({
      canTakeControl: false,
      hasControl: true,
      statusText: expect.stringMatching(/passwords included, the agent can read/),
    });
    expect(describeDesktopPanel(streaming, running, "f".repeat(32)).statusText).toMatch(
      /Another of your windows has control/,
    );
  });

  it("says plainly when the sandbox has no desktop", () => {
    const unavailable: DesktopViewerState = {
      ...initialDesktopViewerState,
      phase: {
        name: "unavailable",
        reason: "no_desktop",
        explanation: "This sandbox has no desktop.",
      },
    };

    expect(describeDesktopPanel(unavailable, running, null).statusText).toBe(
      "This sandbox has no desktop.",
    );
  });
});
