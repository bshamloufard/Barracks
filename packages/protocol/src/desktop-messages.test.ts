import { describe, expect, it } from "vitest";
import { parseControlPlaneToClientMessage } from "./client-messages.js";
import {
  parseControlPlaneToDesktopViewerMessage,
  parseDesktopViewerToControlPlaneMessage,
} from "./desktop-messages.js";
import {
  parseControlPlaneToSupervisorMessage,
  parseSupervisorToControlPlaneMessage,
} from "./supervisor-messages.js";

const streamId = "00112233445566778899aabbccddeeff";
const viewerId = "ffeeddccbbaa99887766554433221100";

describe("desktop messages between control plane and supervisor", () => {
  it("carry a stream request and who holds the desktop's input to the supervisor", () => {
    for (const message of [
      { type: "open_desktop_stream", streamId },
      { type: "desktop_control", holder: "user" },
      { type: "desktop_control", holder: "agent" },
    ]) {
      expect(parseControlPlaneToSupervisorMessage(JSON.stringify(message))).toEqual({
        ok: true,
        value: message,
      });
    }
  });

  it("carry the desktop's availability and a stream's failure to the control plane", () => {
    for (const message of [
      { type: "desktop_availability", status: "running" },
      {
        type: "desktop_availability",
        status: "none",
        explanation: "This sandbox has no desktop.",
      },
      { type: "desktop_stream_failed", streamId, reason: "The desktop is not running." },
    ]) {
      expect(parseSupervisorToControlPlaneMessage(JSON.stringify(message))).toEqual({
        ok: true,
        value: message,
      });
    }
  });

  it("refuse a stream identifier the control plane could not have minted", () => {
    for (const badStreamId of ["../supervisor", streamId.toUpperCase(), `${streamId}0`, ""]) {
      const frame = JSON.stringify({ type: "open_desktop_stream", streamId: badStreamId });
      expect(parseControlPlaneToSupervisorMessage(frame).ok).toBe(false);
    }
  });

  it("refuse a holder that is neither the agent nor the user", () => {
    const frame = JSON.stringify({ type: "desktop_control", holder: "someone-else" });

    expect(parseControlPlaneToSupervisorMessage(frame).ok).toBe(false);
  });
});

describe("desktop messages between control plane and viewer", () => {
  it("tell the viewer it is spliced to the desktop, or why it is not", () => {
    for (const message of [
      { type: "desktop_ready", viewerId },
      {
        type: "desktop_unavailable",
        reason: "sandbox_not_running",
        explanation: "The sandbox is stopped.",
      },
    ]) {
      expect(parseControlPlaneToDesktopViewerMessage(JSON.stringify(message))).toEqual({
        ok: true,
        value: message,
      });
    }
  });

  it("let the viewer authenticate and take or release control, and nothing else", () => {
    for (const message of [
      { type: "authenticate", accessToken: "token" },
      { type: "take_desktop_control" },
      { type: "release_desktop_control" },
    ]) {
      expect(parseDesktopViewerToControlPlaneMessage(JSON.stringify(message)).ok).toBe(true);
    }
    const userMessage = { type: "send_user_message", messageId: "m", text: "hi" };
    expect(parseDesktopViewerToControlPlaneMessage(JSON.stringify(userMessage)).ok).toBe(false);
  });
});

describe("desktop control status for a thread's clients", () => {
  it("names the controlling viewer, or none when the agent has control", () => {
    for (const message of [
      { type: "desktop_control_status", controllingViewerId: viewerId },
      { type: "desktop_control_status", controllingViewerId: null },
    ]) {
      expect(parseControlPlaneToClientMessage(JSON.stringify(message))).toEqual({
        ok: true,
        value: message,
      });
    }
  });
});
