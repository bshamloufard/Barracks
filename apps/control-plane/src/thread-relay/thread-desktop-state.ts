import type {
  DesktopAvailability,
  DesktopControlHolder,
  SupervisorDesktopMessage,
  SupervisorToControlPlaneMessage,
} from "@barrack/protocol";

/**
 * What a thread relay needs to know of threads' desktops: who holds a
 * desktop's control (told to a supervisor that attaches, and to clients
 * after their replay), and where a supervisor's desktop reports go. The
 * desktops' rules live in `desktop/thread-desktops.ts`; the relay only
 * passes these along.
 */
export interface ThreadDesktopState {
  controllingViewerOf(threadId: string): string | null;
  controlHolderOf(threadId: string): DesktopControlHolder;
  noteAvailability(threadId: string, availability: Omit<DesktopAvailability, "type">): void;
  noteStreamFailed(threadId: string, streamId: string, reason: string): void;
  /** The thread's supervisor left this control plane; what it reported no longer holds. */
  noteSupervisorDetached(threadId: string): void;
}

/** For relays built without desktops: nobody ever holds one, and reports are dropped. */
export const noThreadDesktops: ThreadDesktopState = {
  controllingViewerOf: () => null,
  controlHolderOf: () => "agent",
  noteAvailability: () => undefined,
  noteStreamFailed: () => undefined,
  noteSupervisorDetached: () => undefined,
};

export function isSupervisorDesktopMessage(
  message: SupervisorToControlPlaneMessage,
): message is SupervisorDesktopMessage {
  return message.type === "desktop_availability" || message.type === "desktop_stream_failed";
}
