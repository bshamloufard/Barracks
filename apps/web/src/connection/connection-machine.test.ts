import { closeCodes } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import {
  advanceConnection,
  type ConnectionEvent,
  type ConnectionMachineState,
  initialConnectionMachineState,
  reopenConnection,
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

const live: ConnectionEvent[] = [
  { type: "socket_opened", accessToken: "token-1" },
  { type: "first_message_received" },
];

describe("a thread's connection", () => {
  it("authenticates first, with the current token, as soon as the socket opens", () => {
    const { state, lastEffects } = run([{ type: "socket_opened", accessToken: "token-1" }]);

    expect(state.phase).toBe("authenticating");
    expect(lastEffects).toEqual([{ type: "send_authentication", accessToken: "token-1" }]);
  });

  it("is live once the control plane answers", () => {
    expect(run(live).state).toEqual({ phase: "live", failedAttemptCount: 0 });
  });

  it("sends a refreshed token at once while live", () => {
    const { lastEffects } = run([
      ...live,
      { type: "access_token_refreshed", accessToken: "token-2" },
    ]);

    expect(lastEffects).toEqual([{ type: "send_authentication", accessToken: "token-2" }]);
  });

  it("holds a refreshed token back until authenticated, since nothing may follow the first message before the replay", () => {
    const { lastEffects } = run([
      { type: "socket_opened", accessToken: "token-1" },
      { type: "access_token_refreshed", accessToken: "token-2" },
    ]);

    expect(lastEffects).toEqual([]);
  });

  it("refreshes its token and reconnects at once when the token expires on a live connection", () => {
    const { state, lastEffects } = run([
      ...live,
      { type: "socket_closed", closeCode: closeCodes.accessTokenExpired },
    ]);

    expect(state).toEqual({ phase: "waiting", failedAttemptCount: 0 });
    expect(lastEffects).toEqual([
      { type: "reconnect", delayInMilliseconds: 0, refreshAccessTokenFirst: true },
    ]);
  });

  it("backs off when even a refreshed token is refused as expired", () => {
    const { lastEffects } = run([
      ...live,
      { type: "socket_closed", closeCode: closeCodes.accessTokenExpired },
      { type: "socket_opened", accessToken: "token-2" },
      { type: "socket_closed", closeCode: closeCodes.accessTokenExpired },
    ]);

    expect(lastEffects).toEqual([
      { type: "reconnect", delayInMilliseconds: 500, refreshAccessTokenFirst: true },
    ]);
  });

  it("reconnects after a growing delay when dropped for any other reason", () => {
    const delays = [1, 2, 3].map((failures) => {
      const closes: ConnectionEvent[] = Array.from({ length: failures }, () => ({
        type: "socket_closed",
        closeCode: 1006,
      }));
      const { lastEffects } = run([...live, ...closes]);
      return lastEffects[0]?.type === "reconnect" ? lastEffects[0].delayInMilliseconds : undefined;
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
      const { state, lastEffects } = run([...live, { type: "socket_closed", closeCode }]);

      expect(state.phase).toBe("stopped");
      expect(lastEffects).toEqual([{ type: "stop", reason: expect.any(String), consequence }]);
    },
  );

  it("stops, asking the user to sign in, when there is no token to authenticate with", () => {
    const { state, lastEffects } = run([{ type: "socket_opened", accessToken: undefined }]);

    expect(state.phase).toBe("stopped");
    expect(lastEffects).toEqual([
      { type: "close_socket" },
      { type: "stop", reason: expect.any(String), consequence: "sign_in_required" },
    ]);
  });

  it("does nothing more once stopped, and is not reopened", () => {
    const { state } = run([...live, { type: "stop_requested" }]);
    const afterwards = advanceConnection(state, { type: "socket_closed", closeCode: 1006 });

    expect(afterwards).toEqual({ state, effects: [] });
    expect(reopenConnection(state)).toBe(state);
  });
});
