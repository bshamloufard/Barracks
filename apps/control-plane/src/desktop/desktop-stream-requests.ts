import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";

export type StreamRequestOutcome =
  | { ok: true; streamSocket: WebSocket }
  | { ok: false; reason: string };

type PendingStream = {
  threadId: string;
  settle: (outcome: StreamRequestOutcome) => void;
  timer: NodeJS.Timeout;
};

/** How long a supervisor has to dial a stream it was asked for. */
export const defaultStreamOpenTimeoutInMilliseconds = 10_000;

/**
 * The desktop streams this control plane has asked supervisors to open and
 * is still waiting for, each named by an identifier minted here: 16 random
 * bytes, so one cannot be guessed. A supervisor's stream is accepted only
 * for an identifier waiting here for that same thread, and only once: the
 * identifier is forgotten as soon as it is claimed, refused, or not dialled
 * in time. So a sandbox can open no stream nobody asked for, none for
 * another thread, and none twice.
 */
export class DesktopStreamRequests {
  readonly #pending = new Map<string, PendingStream>();
  readonly #timeoutInMilliseconds: number;

  constructor(timeoutInMilliseconds = defaultStreamOpenTimeoutInMilliseconds) {
    this.#timeoutInMilliseconds = timeoutInMilliseconds;
  }

  /**
   * Mints a stream identifier for the thread and calls `ask` with it, which
   * asks the thread's supervisor to dial it, and resolves once the stream
   * arrives, or with why it did not.
   */
  request(threadId: string, ask: (streamId: string) => boolean): Promise<StreamRequestOutcome> {
    const streamId = randomBytes(16).toString("hex");
    const { promise, resolve } = Promise.withResolvers<StreamRequestOutcome>();
    const settle = (outcome: StreamRequestOutcome) => {
      clearTimeout(this.#pending.get(streamId)?.timer);
      this.#pending.delete(streamId);
      resolve(outcome);
    };
    const timer = setTimeout(
      () => settle({ ok: false, reason: "The sandbox did not open the desktop stream in time." }),
      this.#timeoutInMilliseconds,
    );
    this.#pending.set(streamId, { threadId, settle, timer });
    if (!ask(streamId)) {
      settle({ ok: false, reason: "The sandbox is not connected to this control plane." });
    }
    return promise;
  }

  /**
   * Whether a supervisor of `threadId` may open the stream `streamId` now.
   * Checked before its upgrade is accepted; `deliver` then hands the socket
   * over, which claims the identifier.
   */
  isAwaited(threadId: string, streamId: string): boolean {
    return this.#pending.get(streamId)?.threadId === threadId;
  }

  /** Hands the dialled stream to whoever asked; false (and nothing done) if nobody waits for it now. */
  deliver(threadId: string, streamId: string, streamSocket: WebSocket): boolean {
    const pending = this.#pending.get(streamId);
    if (pending === undefined || pending.threadId !== threadId) {
      return false;
    }
    pending.settle({ ok: true, streamSocket });
    return true;
  }

  /** The supervisor said it could not open the stream. Ignored unless it is the thread's own. */
  fail(threadId: string, streamId: string, reason: string): void {
    const pending = this.#pending.get(streamId);
    if (pending?.threadId === threadId) {
      pending.settle({ ok: false, reason });
    }
  }
}
