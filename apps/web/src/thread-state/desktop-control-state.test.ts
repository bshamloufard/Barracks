import { describe, expect, it } from "vitest";
import { initialThreadState, reduceThreadState } from "./thread-state";

const viewerId = "0123456789abcdef0123456789abcdef";

function afterStatuses(...controllingViewerIds: Array<string | null>) {
  return controllingViewerIds.reduce(
    (state, controllingViewerId) =>
      reduceThreadState(state, {
        type: "message_received",
        message: { type: "desktop_control_status", controllingViewerId },
      }),
    initialThreadState,
  );
}

describe("the desktop's control, as a thread's page knows it", () => {
  it("is the agent's until the control plane names a viewer, and then follows what it says", () => {
    expect(afterStatuses().desktopControllingViewerId).toBeNull();
    expect(afterStatuses(viewerId).desktopControllingViewerId).toBe(viewerId);
    expect(afterStatuses(viewerId, null).desktopControllingViewerId).toBeNull();
  });
});
