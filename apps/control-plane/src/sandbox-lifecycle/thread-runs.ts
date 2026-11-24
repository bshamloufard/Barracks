import type { OpenRun } from "../thread-event-log/thread-event-log.js";

/**
 * What the lifecycle asks of the thread relays, which alone record events
 * and talk to supervisors and clients (`ThreadRelayRegistry` implements it).
 */
export interface ThreadRuns {
  /**
   * The thread's sandbox is about to stop: asks its agent to end its run and
   * hands it no more user messages (they wait for the agent that wakes), if
   * its supervisor is attached to this control plane; one attached to
   * another is simply stopped with its sandbox.
   */
  prepareForStop(threadId: string): void;

  /** The stop is over; a supervisor still attached, its stop having failed, gets the messages held back. */
  finishStop(threadId: string): void;

  /**
   * If `run` is still open in the thread's history, records its end as a
   * failure with `errorMessage`, in sequence with everything else the relay
   * records, and shows it to everyone watching. Of any number of calls for
   * one run, from any control plane, at most one records anything.
   */
  closeOpenRun(threadId: string, run: OpenRun, errorMessage: string): Promise<void>;

  /**
   * Disconnects every client and supervisor attached to a thread whose
   * record has been removed, and removes its history once anything this
   * control plane was still recording for it is recorded.
   */
  forgetDeletedThread(threadId: string): Promise<void>;
}
