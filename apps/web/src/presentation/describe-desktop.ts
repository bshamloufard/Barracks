import type { ThreadSandbox } from "@barrack/protocol";
import type { DesktopViewerState } from "../desktop/desktop-viewer-machine";
import { availableLifecycleActions } from "./describe-sandbox";

/** What the desktop panel says, and which of its buttons it offers. */
export type DesktopPanelView = {
  statusText: string;
  /** The desktop is on screen (it may be watching or in control). */
  isStreaming: boolean;
  hasControl: boolean;
  canTakeControl: boolean;
  /** The sandbox is stopped: the panel offers to wake it rather than waking it on its own. */
  offersWake: boolean;
};

export function describeDesktopPanel(
  state: DesktopViewerState,
  sandbox: ThreadSandbox,
  controllingViewerId: string | null,
): DesktopPanelView {
  const notStreaming = { isStreaming: false, hasControl: false, canTakeControl: false };
  if (sandbox.state !== "running") {
    const offersWake = availableLifecycleActions(sandbox).canResume;
    return {
      ...notStreaming,
      offersWake,
      statusText: offersWake
        ? "The sandbox is stopped, so its desktop is too. Wake it to see the desktop."
        : describeSandboxOnItsWay(sandbox),
    };
  }
  const { phase } = state;
  switch (phase.name) {
    case "streaming":
      return describeStreaming(phase.viewerId, controllingViewerId);
    case "idle":
      return {
        ...notStreaming,
        offersWake: false,
        statusText: state.conditions.isPageVisible
          ? "The desktop is hidden."
          : "Paused while this tab is hidden.",
      };
    case "waiting":
      return {
        ...notStreaming,
        offersWake: false,
        statusText: phase.explanation ?? "Reconnecting to the desktop…",
      };
    case "unavailable":
      return { ...notStreaming, offersWake: false, statusText: phase.explanation };
    case "stopped":
      return { ...notStreaming, offersWake: false, statusText: phase.reason };
    default:
      return { ...notStreaming, offersWake: false, statusText: "Connecting to the desktop…" };
  }
}

function describeStreaming(viewerId: string, controllingViewerId: string | null): DesktopPanelView {
  const streaming = { isStreaming: true, offersWake: false };
  if (controllingViewerId === viewerId) {
    return {
      ...streaming,
      hasControl: true,
      canTakeControl: false,
      statusText:
        "You have control. The agent leaves the mouse and keyboard alone until you give it back. Anything you type here, passwords included, the agent can read.",
    };
  }
  return {
    ...streaming,
    hasControl: false,
    canTakeControl: true,
    statusText:
      controllingViewerId === null
        ? "Watching the agent's desktop."
        : "Watching. Another of your windows has control.",
  };
}

function describeSandboxOnItsWay(sandbox: ThreadSandbox): string {
  switch (sandbox.state) {
    case "creating":
    case "starting":
      return "The sandbox is starting; its desktop will show here.";
    case "stopping":
      return "The sandbox is stopping.";
    case "deleting":
      return "This thread is being deleted.";
    default:
      return "The sandbox is not running, so there is no desktop to show.";
  }
}
