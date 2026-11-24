import { type RefObject, useEffect, useRef, useState } from "react";
import { useSession } from "../authentication/session-context";
import { DesktopViewerConnection, type VncClientFactory } from "./desktop-viewer-connection";
import {
  type DesktopViewerConditions,
  type DesktopViewerState,
  initialDesktopViewerState,
} from "./desktop-viewer-machine";

/**
 * noVNC's defaults for picture quality and compression: a fair balance on
 * a home connection, and what the bandwidth figures in docs/decisions.md
 * were measured with.
 */
const qualityLevel = 6;
const compressionLevel = 2;

export type DesktopViewerControls = {
  state: DesktopViewerState;
  /** Where noVNC draws the desktop. */
  screenReference: RefObject<HTMLDivElement | null>;
  takeControl: () => void;
  giveControlBack: () => void;
};

/**
 * Follows a thread's desktop for as long as the calling component is
 * mounted: connected while the sandbox runs, the panel is open and the tab
 * is visible, and closed otherwise. noVNC is loaded only once a desktop is
 * first wanted, so it stays out of the page's main bundle.
 */
export function useDesktopViewer(
  threadId: string,
  wanted: { isSandboxRunning: boolean; isPanelOpen: boolean },
  controllingViewerId: string | null,
): DesktopViewerControls {
  const session = useSession();
  const screenReference = useRef<HTMLDivElement | null>(null);
  const connectionReference = useRef<DesktopViewerConnection | undefined>(undefined);
  const [state, setState] = useState<DesktopViewerState>(initialDesktopViewerState);
  const [isPageVisible, setIsPageVisible] = useState(() => document.visibilityState === "visible");
  const conditions: DesktopViewerConditions = { ...wanted, isPageVisible };
  const latestConditions = useRef(conditions);
  latestConditions.current = conditions;
  const isWantedAtAll = wanted.isSandboxRunning && wanted.isPanelOpen;
  const [hasBeenWanted, setHasBeenWanted] = useState(isWantedAtAll);
  if (isWantedAtAll && !hasBeenWanted) {
    setHasBeenWanted(true);
  }

  useEffect(() => {
    const follow = () => setIsPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", follow);
    return () => document.removeEventListener("visibilitychange", follow);
  }, []);

  useEffect(() => {
    if (!hasBeenWanted) {
      return;
    }
    let isCancelled = false;
    let connection: DesktopViewerConnection | undefined;
    void import("@novnc/novnc").then(({ default: RFB }) => {
      if (isCancelled) {
        return;
      }
      const createVncClient: VncClientFactory = (socket, viewOnly) => {
        const target = screenReference.current;
        if (target === null) {
          throw new Error("The desktop's screen is not on the page.");
        }
        // Created at once, in the handler that saw `desktop_ready`, so
        // noVNC reads the socket from its first VNC byte.
        const rfb = new RFB(target, socket, { shared: true });
        rfb.viewOnly = viewOnly;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.qualityLevel = qualityLevel;
        rfb.compressionLevel = compressionLevel;
        return {
          setViewOnly: (isViewOnly) => {
            rfb.viewOnly = isViewOnly;
          },
          disconnect: () => rfb.disconnect(),
        };
      };
      connection = new DesktopViewerConnection({
        threadId,
        session,
        createVncClient,
        onChange: setState,
      });
      connectionReference.current = connection;
      connection.start(latestConditions.current);
    });
    return () => {
      isCancelled = true;
      connection?.stop();
      connectionReference.current = undefined;
    };
  }, [hasBeenWanted, threadId, session]);

  const { isSandboxRunning, isPanelOpen } = conditions;
  useEffect(() => {
    connectionReference.current?.updateConditions({ isSandboxRunning, isPanelOpen, isPageVisible });
  }, [isSandboxRunning, isPanelOpen, isPageVisible]);

  const viewerId = state.phase.name === "streaming" ? state.phase.viewerId : undefined;
  useEffect(() => {
    connectionReference.current?.setViewOnly(
      viewerId === undefined || controllingViewerId !== viewerId,
    );
  }, [viewerId, controllingViewerId]);

  return {
    state,
    screenReference,
    takeControl: () => connectionReference.current?.requestControl(true),
    giveControlBack: () => connectionReference.current?.requestControl(false),
  };
}
