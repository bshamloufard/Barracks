import type { ThreadSummary } from "@barrack/protocol";
import { useState } from "react";
import { useDesktopViewer } from "../desktop/use-desktop-viewer";
import { describeDesktopPanel } from "../presentation/describe-desktop";

type DesktopPanelProperties = {
  thread: ThreadSummary;
  /** Which viewer holds the desktop's control, as the thread's connection last said. */
  controllingViewerId: string | null;
  isWaking: boolean;
  onWake: () => void;
};

/**
 * The thread's live desktop, which the user watches the agent work on and
 * can take over. noVNC draws it into the screen below, scaled to the page's
 * width, so it fits a phone as well as a laptop. Whatever the desktop sends
 * is drawn on a canvas only; its name and clipboard are never shown or
 * copied to the user's clipboard.
 */
export function DesktopPanel({
  thread,
  controllingViewerId,
  isWaking,
  onWake,
}: DesktopPanelProperties) {
  const [isOpen, setIsOpen] = useState(true);
  const isSandboxRunning = thread.sandbox.state === "running";
  const viewer = useDesktopViewer(
    thread.threadId,
    { isSandboxRunning, isPanelOpen: isOpen },
    controllingViewerId,
  );
  const view = describeDesktopPanel(viewer.state, thread.sandbox, controllingViewerId);
  return (
    <section className="desktop-panel" aria-label="Desktop">
      <div className="desktop-bar">
        <h2>Desktop</h2>
        <span className="desktop-status" role="status" data-testid="desktop-status">
          {view.statusText}
        </span>
        <div className="desktop-actions">
          {view.offersWake && (
            <button type="button" disabled={isWaking} onClick={onWake}>
              {isWaking ? "Waking…" : "Wake the sandbox"}
            </button>
          )}
          {view.canTakeControl && (
            <button type="button" onClick={viewer.takeControl}>
              Take control
            </button>
          )}
          {view.hasControl && (
            <button type="button" onClick={viewer.giveControlBack}>
              Give control back
            </button>
          )}
          <button type="button" className="quiet-button" onClick={() => setIsOpen(!isOpen)}>
            {isOpen ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {isOpen && (
        <div
          className={`desktop-screen${view.hasControl ? " desktop-screen-controlled" : ""}`}
          data-testid="desktop-screen"
          ref={viewer.screenReference}
        />
      )}
    </section>
  );
}
