import { maximumFrameLength, maximumUnconfirmedAgentEventsLength } from "@barrack/protocol";

/**
 * How much of what a thread's supervisors sent may wait in its relay's
 * queue, in characters of the frames it came in. Everything a supervisor
 * sends waits there while an append is under way, and a sandbox is
 * untrusted: unbounded, one that keeps sending while the database is slow
 * could exhaust the control plane's memory and take every thread down.
 *
 * An honest supervisor never has more than `maximumUnconfirmedAgentEventsLength`
 * of agent events unconfirmed, and so never more than that waiting here; a
 * frame's worth more leaves room for its small acknowledgements and its
 * hello. A supervisor that goes past it is disconnected rather than slowed
 * down: pausing its socket would also stop its heartbeat being read, and
 * disconnecting it loses nothing, since a supervisor keeps every agent
 * event until it is confirmed and sends them all again once it reconnects.
 * The count is per thread, not per connection, so a sandbox opening
 * several connections gets no more.
 */
export const supervisorMessagesBacklogLimit =
  maximumUnconfirmedAgentEventsLength + maximumFrameLength;

/**
 * Stream fragments are only a preview of text that is recorded anyway, and
 * may be lost, so they get a budget of their own (fragments are tens of
 * characters each, so this is tens of thousands of them) and are dropped
 * once it is spent rather than counted against the events.
 */
export const streamFragmentsBacklogLimit = 1024 * 1024;

/**
 * Keeps account of what a thread's supervisors sent that is waiting in its
 * relay's queue, and decides what may join it.
 *
 * Once a fragment of an assistant message is dropped, the rest of that
 * message's fragments are dropped too, so a viewer sees its text stop
 * rather than come out with a piece missing; the recorded message replaces
 * it either way.
 */
export class SupervisorBacklog {
  #messagesLength = 0;
  #fragmentsLength = 0;
  #messageIdMissingFragments: string | undefined;

  /** Counts a message in and returns true, or returns false if it would go past the limit. */
  admitMessage(frameLength: number): boolean {
    if (this.#messagesLength + frameLength > supervisorMessagesBacklogLimit) {
      return false;
    }
    this.#messagesLength += frameLength;
    return true;
  }

  releaseMessage(frameLength: number): void {
    this.#messagesLength -= frameLength;
  }

  /** Counts a fragment in and returns true, or returns false if it is to be dropped. */
  admitFragment(messageId: string, frameLength: number): boolean {
    if (messageId === this.#messageIdMissingFragments) {
      return false;
    }
    if (this.#fragmentsLength + frameLength > streamFragmentsBacklogLimit) {
      this.#messageIdMissingFragments = messageId;
      return false;
    }
    this.#fragmentsLength += frameLength;
    return true;
  }

  releaseFragment(frameLength: number): void {
    this.#fragmentsLength -= frameLength;
  }

  /** How many characters of messages, and of fragments, are waiting. */
  get queuedLengths(): { messages: number; fragments: number } {
    return { messages: this.#messagesLength, fragments: this.#fragmentsLength };
  }
}
