import type {
  ControlPlaneDesktopMessage,
  DesktopAvailability,
  DesktopControlHolder,
} from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { ThreadDesktopState } from "../thread-relay/thread-desktop-state.js";
import { DesktopStreamRequests } from "./desktop-stream-requests.js";

/**
 * As many viewers as a user plausibly watches one thread from (a laptop, a
 * phone, a second window), and so as many streams as one sandbox is asked
 * to carry at once; each costs the sandbox a VNC connection and the
 * control plane its bandwidth.
 */
export const maximumViewersPerThread = 4;

export type DesktopAvailabilityReport = Omit<DesktopAvailability, "type">;

/** How the desktops reach a thread's supervisor and clients: through its relay. */
export interface DesktopSupervisorChannel {
  /** Sends to the thread's supervisor attached here; false if there is none. */
  sendDesktopMessage(threadId: string, message: ControlPlaneDesktopMessage): boolean;
  /** Tells the thread's clients who holds the desktop now. */
  broadcastDesktopControlStatus(threadId: string): void;
}

/** One viewer's connection, as the desktops know it. */
export type AttachedViewer = { viewerId: string };

type ThreadDesktop = {
  viewers: Map<string, AttachedViewer>;
  controllingViewerId: string | null;
  /** What the thread's supervisor last reported; undefined until it has. */
  availability: DesktopAvailabilityReport | undefined;
};

/**
 * What the control plane knows of each thread's desktop: its viewers here,
 * which of them holds control, and whether its supervisor reports a
 * desktop. Control is held by one viewer at a time, or by nobody (the
 * agent); taking it moves it, and releasing it or the viewer going gives it
 * back. Each change is told to the supervisor (`desktop_control`), so the
 * agent's tool stands back, and to the thread's clients
 * (`desktop_control_status`), so each viewer knows whether it is the one.
 */
export class ThreadDesktops implements ThreadDesktopState {
  readonly streamRequests: DesktopStreamRequests;
  readonly #channel: () => DesktopSupervisorChannel;
  readonly #logger: Logger;
  readonly #desktops = new Map<string, ThreadDesktop>();

  constructor(options: {
    /** A function, since the relays and the desktops each need the other. */
    channel: () => DesktopSupervisorChannel;
    logger: Logger;
    streamRequests?: DesktopStreamRequests;
  }) {
    this.#channel = options.channel;
    this.#logger = options.logger;
    this.streamRequests = options.streamRequests ?? new DesktopStreamRequests();
  }

  controllingViewerOf(threadId: string): string | null {
    return this.#desktops.get(threadId)?.controllingViewerId ?? null;
  }

  controlHolderOf(threadId: string): DesktopControlHolder {
    return this.controllingViewerOf(threadId) === null ? "agent" : "user";
  }

  availabilityOf(threadId: string): DesktopAvailabilityReport | undefined {
    return this.#desktops.get(threadId)?.availability;
  }

  noteAvailability(threadId: string, availability: DesktopAvailabilityReport): void {
    this.#desktopOf(threadId).availability = availability;
    this.#logger.info(
      { threadId, desktopStatus: availability.status },
      "A sandbox's desktop changed",
    );
  }

  noteStreamFailed(threadId: string, streamId: string, reason: string): void {
    this.streamRequests.fail(threadId, streamId, reason);
  }

  /** What a supervisor no longer here reported says nothing about the next one. */
  noteSupervisorDetached(threadId: string): void {
    const desktop = this.#desktops.get(threadId);
    if (desktop === undefined) {
      return;
    }
    desktop.availability = undefined;
    this.#forgetIfIdle(threadId, desktop);
  }

  /** Admits a viewer unless the thread has as many as it may. */
  admitViewer(threadId: string, viewer: AttachedViewer): boolean {
    const desktop = this.#desktopOf(threadId);
    if (desktop.viewers.size >= maximumViewersPerThread) {
      return false;
    }
    desktop.viewers.set(viewer.viewerId, viewer);
    return true;
  }

  /** A viewer that held control gives it back to the agent as it goes. */
  removeViewer(threadId: string, viewerId: string): void {
    const desktop = this.#desktops.get(threadId);
    if (desktop === undefined || !desktop.viewers.delete(viewerId)) {
      return;
    }
    if (desktop.controllingViewerId === viewerId) {
      this.#changeControl(threadId, desktop, null);
    }
    this.#forgetIfIdle(threadId, desktop);
  }

  takeControl(threadId: string, viewerId: string): void {
    const desktop = this.#desktops.get(threadId);
    if (desktop?.viewers.has(viewerId) !== true || desktop.controllingViewerId === viewerId) {
      return;
    }
    this.#changeControl(threadId, desktop, viewerId);
  }

  /** Only the viewer holding control can give it back. */
  releaseControl(threadId: string, viewerId: string): void {
    const desktop = this.#desktops.get(threadId);
    if (desktop?.controllingViewerId === viewerId) {
      this.#changeControl(threadId, desktop, null);
    }
  }

  isControlling(threadId: string, viewerId: string): boolean {
    return this.controllingViewerOf(threadId) === viewerId;
  }

  #changeControl(threadId: string, desktop: ThreadDesktop, viewerId: string | null): void {
    const previousHolder = desktop.controllingViewerId === null ? "agent" : "user";
    desktop.controllingViewerId = viewerId;
    const holder = viewerId === null ? "agent" : "user";
    this.#logger.info({ threadId, holder, viewerId }, "The desktop's control changed hands");
    const channel = this.#channel();
    if (holder !== previousHolder) {
      // A supervisor not attached here is told when it next is.
      channel.sendDesktopMessage(threadId, { type: "desktop_control", holder });
    }
    channel.broadcastDesktopControlStatus(threadId);
  }

  #desktopOf(threadId: string): ThreadDesktop {
    let desktop = this.#desktops.get(threadId);
    if (desktop === undefined) {
      desktop = { viewers: new Map(), controllingViewerId: null, availability: undefined };
      this.#desktops.set(threadId, desktop);
    }
    return desktop;
  }

  #forgetIfIdle(threadId: string, desktop: ThreadDesktop): void {
    if (desktop.viewers.size === 0 && desktop.availability === undefined) {
      this.#desktops.delete(threadId);
    }
  }
}
