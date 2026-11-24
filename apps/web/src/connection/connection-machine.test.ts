import { closeCodes } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import type { AccessTokenLookup } from "../authentication/sign-in-service";
import {
  advanceConnection,
  type ConnectionEvent,
  type ConnectionMachineState,
  initialConnectionMachineState,
} from "./connection-machine";

/** No jitter, so delays are exact. */
const noJitter = () => 1;

function run(events: ConnectionEvent[], state = initialConnectionMachineState) {
  let current: ConnectionMachineState = state;
  let effects: ReturnType<typeof advanceConnection>["effects"] = [];
  for (const event of events) {
    ({ state: current, effects } = advanceConnection(current, event, noJitter));
  }
  return { state: current, lastEffects: effects };
}

function tokenObtained(accessToken: string): ConnectionEvent {
  return { type: "access_token_obtained", lookup: { status: "available", accessToken } };
}

const offline: AccessTokenLookup = { status: "unavailable", reason: "Failed to fetch" };

/** One attempt up to an open socket, with the token in hand. */
function attemptWith(accessToken: string): ConnectionEvent[] {
  return [{ type: "attempt_started" }, tokenObtained(accessToken), { type: "socket_opened" }];
}

const live: ConnectionEvent[] = [...attemptWith("token-1"), { type: "first_message_received" }];

function closedWith(closeCode: number): ConnectionEvent {
  return { type: "socket_closed", closeCode };
}

describe("a thread's connection", () => {
  it("obtains a token before it opens a socket", () => {
    const asked = run([{ type: "attempt_started" }]);
    const obtained = run([{ type: "attempt_started" }, tokenObtained("token-1")]);

    expect(asked.state.phase).toBe("obtaining_access_token");
    expect(asked.lastEffects).toEqual([{ type: "obtain_access_token", refreshFirst: false }]);
    expect(obtained.state.phase).toBe("opening");
    expect(obtained.lastEffects).toEqual([{ type: "open_socket" }]);
  });

  it("authenticates first, with the token it obtained, as soon as the socket opens", () => {
    const { state, lastEffects } = run(attemptWith("token-1"));

    expect(state.phase).toBe("authenticating");
    expect(lastEffects).toEqual([{ type: "send_authentication", accessToken: "token-1" }]);
  });

  it("is live once the control plane answers", () => {
    expect(run(live).state).toMatchObject({ phase: "live", failedAttemptCount: 0 });
  });

  it("keeps the session and tries again after a growing delay while no token can be had", () => {
    const delays = [1, 2, 3].map((failures) => {
      const lookups = Array.from({ length: failures }, (): ConnectionEvent[] => [
        { type: "attempt_started" },
        { type: "access_token_obtained", lookup: offline },
      ]).flat();
      const { state, lastEffects } = run(lookups);
      expect(state.phase).toBe("waiting");
      return lastEffects;
    });

    expect(delays).toEqual([
      [{ type: "retry", delayInMilliseconds: 500 }],
      [{ type: "retry", delayInMilliseconds: 1000 }],
      [{ type: "retry", delayInMilliseconds: 2000 }],
    ]);
  });

  it("recovers once a token can be had again, starting the backoff afresh", () => {
    const { state } = run([
      { type: "attempt_started" },
      { type: "access_token_obtained", lookup: offline },
      ...live,
    ]);

    expect(state).toMatchObject({ phase: "live", failedAttemptCount: 0 });
  });

  it("stops, asking the user to sign in, only when the session is definitely gone", () => {
    const { state, lastEffects } = run([
      { type: "attempt_started" },
      { type: "access_token_obtained", lookup: { status: "signed_out" } },
    ]);

    expect(state.phase).toBe("stopped");
    expect(lastEffects).toEqual([
      { type: "stop", reason: expect.any(String), consequence: "sign_in_required" },
    ]);
  });

  it("ignores a token lookup that arrives when none is awaited", () => {
    const { state, lastEffects } = run([...live, tokenObtained("token-9")]);

    expect(state.phase).toBe("live");
    expect(lastEffects).toEqual([]);
  });

  it("ignores a socket opening when it has no token to send", () => {
    const { state, lastEffects } = run([{ type: "attempt_started" }, { type: "socket_opened" }]);

    expect(state.phase).toBe("obtaining_access_token");
    expect(lastEffects).toEqual([]);
  });

  it("sends a refreshed token at once while live", () => {
    const { lastEffects } = run([
      ...live,
      { type: "access_token_refreshed", accessToken: "token-2" },
    ]);

    expect(lastEffects).toEqual([{ type: "send_authentication", accessToken: "token-2" }]);
  });

  it("authenticates with a token refreshed while its socket was opening", () => {
    const { lastEffects } = run([
      { type: "attempt_started" },
      tokenObtained("token-1"),
      { type: "access_token_refreshed", accessToken: "token-2" },
      { type: "socket_opened" },
    ]);

    expect(lastEffects).toEqual([{ type: "send_authentication", accessToken: "token-2" }]);
  });

  it("holds a refreshed token back until authenticated, since nothing may follow the first message before the replay", () => {
    const { lastEffects } = run([
      ...attemptWith("token-1"),
      { type: "access_token_refreshed", accessToken: "token-2" },
    ]);

    expect(lastEffects).toEqual([]);
  });

  it("refreshes its token and reconnects at once when the token expires on a live connection", () => {
    const expired = run([...live, closedWith(closeCodes.accessTokenExpired)]);
    const nextAttempt = run([{ type: "attempt_started" }], expired.state);

    expect(expired.state).toMatchObject({ phase: "waiting", failedAttemptCount: 0 });
    expect(expired.lastEffects).toEqual([{ type: "retry", delayInMilliseconds: 0 }]);
    expect(nextAttempt.lastEffects).toEqual([{ type: "obtain_access_token", refreshFirst: true }]);
  });

  it("backs off, and refreshes again, when even a refreshed token is refused as expired", () => {
    const { state, lastEffects } = run([
      ...live,
      closedWith(closeCodes.accessTokenExpired),
      ...attemptWith("token-2"),
      closedWith(closeCodes.accessTokenExpired),
    ]);

    expect(lastEffects).toEqual([{ type: "retry", delayInMilliseconds: 500 }]);
    expect(state.mustRefreshAccessToken).toBe(true);
  });

  it("keeps refreshing on the next attempt when the refresh could not be made", () => {
    const { lastEffects } = run([
      ...live,
      closedWith(closeCodes.accessTokenExpired),
      { type: "attempt_started" },
      { type: "access_token_obtained", lookup: offline },
      { type: "attempt_started" },
    ]);

    expect(lastEffects).toEqual([{ type: "obtain_access_token", refreshFirst: true }]);
  });

  it("reconnects after a growing delay, keeping the session, when authentication timed out", () => {
    const { state, lastEffects } = run([
      ...attemptWith("token-1"),
      closedWith(closeCodes.authenticationTimedOut),
    ]);

    expect(state.phase).toBe("waiting");
    expect(lastEffects).toEqual([{ type: "retry", delayInMilliseconds: 500 }]);
  });

  it("reconnects after a growing delay when dropped for any other reason", () => {
    const delays = [1, 2, 3].map((failures) => {
      const closes = Array.from({ length: failures }, () => closedWith(1006));
      const { lastEffects } = run([...live, ...closes]);
      return lastEffects[0]?.type === "retry" ? lastEffects[0].delayInMilliseconds : undefined;
    });

    expect(delays).toEqual([500, 1000, 2000]);
  });

  it.each([
    [closeCodes.notAuthenticated, "sign_in_required"],
    [closeCodes.userNotAllowed, "not_allowed"],
    [closeCodes.threadNotFound, "thread_not_found"],
    [closeCodes.invalidMessage, "none"],
  ] as const)(
    "stops for good when closed with %i, which reconnecting would not help",
    (closeCode, consequence) => {
      const { state, lastEffects } = run([...live, closedWith(closeCode)]);

      expect(state.phase).toBe("stopped");
      expect(lastEffects).toEqual([{ type: "stop", reason: expect.any(String), consequence }]);
    },
  );

  it("closes its socket when asked to stop, and does nothing more once stopped", () => {
    const { state, lastEffects } = run([...live, { type: "stop_requested" }]);
    const afterwards = advanceConnection(state, closedWith(1006));
    const noNewAttempt = advanceConnection(state, { type: "attempt_started" });

    expect(lastEffects).toEqual([{ type: "close_socket" }]);
    expect(afterwards).toEqual({ state, effects: [] });
    expect(noNewAttempt).toEqual({ state, effects: [] });
  });
});
