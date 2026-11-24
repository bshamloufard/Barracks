import type {
  AssistantTextFragment,
  ClientMessageRejected,
  ControlPlaneToClientMessage,
  DesktopControlStatus,
  RecordedThreadEvent,
  SupervisorConnectionStatus,
  ThreadEvent,
  ThreadEventMessage,
  UserMessageDeliveryStatus,
} from "@barrack/protocol";
import type { Logger } from "../logger.js";
import { standardCloseCodes } from "../standard-close-codes.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type { ClientConnection } from "./connections.js";
import { InProgressAssistantText } from "./in-progress-assistant-text.js";
import { findMissedRange, type MissedRange, readMissedEvents } from "./read-missed-events.js";
import type { ThreadDesktopState } from "./thread-desktop-state.js";

/*
 * The clients watching one thread, and what each is sent when: first the
 * history it missed, a page at a time, then the thread's state as it is now
 * (whether a supervisor is attached, how far user messages are delivered,
 * the text streamed so far, who holds the desktop), then live traffic, so
 * that it sees every thread event exactly once and in sequence order
 * however it joined. The thread's relay decides what happened; this decides
 * which client is told it, and whether now, later or never.
 */

/** The messages that must still reach a client once its replay is over. */
type HeldBackMessage = ThreadEventMessage | ClientMessageRejected;

/**
 * While a client is being replayed its history, the protocol promises it
 * nothing but the announced events, so thread events recorded meanwhile and
 * rejections of what it sent wait here. Stream fragments and the two
 * statuses are dropped instead: the client is sent the current statuses and
 * the text streamed so far when its replay ends, which supersede them, so
 * holding them would only cost memory for as long as a slow replay lasts.
 *
 * A live client is sent each thread event only if it is the one after the
 * last it was sent. An event at or below that was already replayed to it: an
 * append can be committed, and so replayed, before the log's answer reaches
 * the relay and the relay broadcasts it. An event further on means the
 * client missed one this relay never broadcast, because another control
 * plane instance recorded it or because an append reported as failed was
 * committed after all; that client is disconnected, so it reconnects and
 * replays what it missed from the log, rather than being shown a gap.
 */
type ClientPhase =
  | { name: "replaying"; heldBackMessages: HeldBackMessage[] }
  | { name: "live"; lastSentSequence: number };

export type ThreadClientsOptions = {
  threadId: string;
  threadEventLog: ThreadEventLog;
  desktops: ThreadDesktopState;
  /** Whether the thread's supervisor is attached here, as clients are told. */
  isSupervisorAttached: () => boolean;
  logger: Logger;
  /** Called after a client is disconnected here, for having missed thread events. */
  whenClientDisconnected: () => void;
};

export class ThreadClients {
  readonly #threadId: string;
  readonly #threadEventLog: ThreadEventLog;
  readonly #desktops: ThreadDesktopState;
  readonly #isSupervisorAttached: () => boolean;
  readonly #logger: Logger;
  readonly #whenClientDisconnected: () => void;
  readonly #phases = new Map<ClientConnection, ClientPhase>();
  readonly #inProgressText = new InProgressAssistantText();
  /** The furthest delivery of user messages known here; it only grows. */
  #userMessagesDeliveredThrough = 0;

  constructor(options: ThreadClientsOptions) {
    this.#threadId = options.threadId;
    this.#threadEventLog = options.threadEventLog;
    this.#desktops = options.desktops;
    this.#isSupervisorAttached = options.isSupervisorAttached;
    this.#logger = options.logger;
    this.#whenClientDisconnected = options.whenClientDisconnected;
  }

  /**
   * Registers a client that is about to be replayed its history. It is
   * registered before the log is read, so any event recorded while the
   * replay is under way is held back for it rather than missed.
   */
  add(client: ClientConnection): void {
    this.#phases.set(client, { name: "replaying", heldBackMessages: [] });
  }

  /** The client is sent nothing more, including the rest of a replay under way. */
  remove(client: ClientConnection): void {
    this.#phases.delete(client);
  }

  get count(): number {
    return this.#phases.size;
  }

  /** Every client registered, in the order they were registered. */
  all(): ClientConnection[] {
    return [...this.#phases.keys()];
  }

  /**
   * Replays to a client just added the history it missed, then switches it
   * to live traffic. Events the replay already covered are skipped among
   * those held back for it meanwhile, so none is sent twice. A client
   * removed part way is sent nothing more.
   */
  async replayThenGoLive(client: ClientConnection, lastSeenSequence: number): Promise<void> {
    const range = await findMissedRange(
      this.#threadEventLog,
      this.#threadId,
      lastSeenSequence,
      this.#logger,
    );
    this.advanceUserMessagesDeliveredThrough(
      await this.#threadEventLog.readUserMessagesDeliveredThrough(this.#threadId),
    );
    const wasReplayCompleted = await this.#replay(client, range);
    if (!wasReplayCompleted) {
      return;
    }
    // From here to the end nothing is awaited, so no event can slip in
    // between the held-back messages and the switch to live.
    this.#goLive(client, range.lastSequence);
    this.#logger.info(
      { replayedEventCount: range.lastSequence - range.afterSequence },
      "Client caught up and is live",
    );
  }

  /**
   * Sends the announcement, then the announced events as they are read from
   * the log a page at a time, each once the one before has been handed to
   * the network. Returns false if the client was removed before the replay
   * was over.
   */
  async #replay(client: ClientConnection, range: MissedRange): Promise<boolean> {
    if (!this.#phases.has(client)) {
      return false;
    }
    await client.sendAndWaitUntilWritten({
      type: "replay_announcement",
      firstSequence: range.afterSequence + 1,
      lastSequence: range.lastSequence,
    });
    const missedEvents = readMissedEvents(this.#threadEventLog, this.#threadId, range);
    for await (const recordedEvent of missedEvents) {
      if (!this.#phases.has(client)) {
        return false;
      }
      await client.sendAndWaitUntilWritten({ type: "thread_event", ...recordedEvent });
    }
    return this.#phases.has(client);
  }

  /**
   * Sends a client whose replay is over what was held back for it, then the
   * thread's state as it is now, which supersedes the statuses and
   * fragments it was not sent meanwhile.
   */
  #goLive(client: ClientConnection, lastReplayedSequence: number): void {
    const phase = this.#phases.get(client);
    const heldBackMessages = phase?.name === "replaying" ? phase.heldBackMessages : [];
    this.#phases.set(client, { name: "live", lastSentSequence: lastReplayedSequence });
    for (const message of heldBackMessages) {
      this.#send(client, message);
    }
    client.send(this.#supervisorConnectionStatus());
    client.send(this.#userMessageDeliveryStatus());
    for (const fragment of this.#inProgressText.toCoalescedFragments()) {
      client.send({ type: "stream_fragment", fragment });
    }
    client.send(this.#desktopControlStatus());
  }

  /** Shows every client a thread event just recorded; it supersedes any text streamed for it. */
  showRecordedEvent(recordedEvent: RecordedThreadEvent): void {
    this.#forgetTextSupersededBy(recordedEvent.event);
    this.#broadcast({ type: "thread_event", ...recordedEvent });
  }

  #forgetTextSupersededBy(event: ThreadEvent): void {
    if (event.type === "assistant_message") {
      this.#inProgressText.discardMessage(event.messageId);
    }
    if (event.type === "agent_run_settled" || event.type === "agent_failed") {
      this.#inProgressText.discardCurrentMessage();
    }
  }

  /** Shows every client a piece of streamed text, and keeps it for clients that join mid-message. */
  relayAssistantTextFragment(fragment: AssistantTextFragment): void {
    if (this.#inProgressText.append(fragment) === "exceeded_limit") {
      this.#logger.warn(
        { messageId: fragment.messageId },
        "Stopped keeping streamed text for an assistant message that went past a size limit",
      );
    }
    this.#broadcast({ type: "stream_fragment", fragment });
  }

  get userMessagesDeliveredThrough(): number {
    return this.#userMessagesDeliveredThrough;
  }

  /** Moves the furthest delivery on, and tells every client, if `throughSequence` is further. */
  advanceUserMessagesDeliveredThrough(throughSequence: number): void {
    if (throughSequence <= this.#userMessagesDeliveredThrough) {
      return;
    }
    this.#userMessagesDeliveredThrough = throughSequence;
    this.#broadcast(this.#userMessageDeliveryStatus());
  }

  broadcastSupervisorConnectionStatus(): void {
    const status = this.#supervisorConnectionStatus();
    this.#logger.info(
      { isSupervisorConnected: status.isSupervisorConnected },
      "Supervisor connection changed",
    );
    this.#broadcast(status);
  }

  broadcastDesktopControlStatus(): void {
    this.#broadcast(this.#desktopControlStatus());
  }

  /** `messageId` names the user message refused; an interrupt has none. */
  reject(client: ClientConnection, reason: string, messageId?: string): void {
    this.#logger.info({ reason, messageId }, "Rejected a client message");
    this.#send(client, {
      type: "client_message_rejected",
      reason,
      ...(messageId === undefined ? {} : { messageId }),
    });
  }

  #supervisorConnectionStatus(): SupervisorConnectionStatus {
    return {
      type: "supervisor_connection_status",
      isSupervisorConnected: this.#isSupervisorAttached(),
    };
  }

  #desktopControlStatus(): DesktopControlStatus {
    return {
      type: "desktop_control_status",
      controllingViewerId: this.#desktops.controllingViewerOf(this.#threadId),
    };
  }

  #userMessageDeliveryStatus(): UserMessageDeliveryStatus {
    return {
      type: "user_message_delivery_status",
      deliveredThroughSequence: this.#userMessagesDeliveredThrough,
    };
  }

  #broadcast(message: ControlPlaneToClientMessage): void {
    for (const client of this.#phases.keys()) {
      this.#send(client, message);
    }
  }

  /** Sends to one client, held back, skipped or sent as its phase requires. */
  #send(client: ClientConnection, message: ControlPlaneToClientMessage): void {
    const phase = this.#phases.get(client);
    if (phase?.name === "replaying") {
      if (message.type === "thread_event" || message.type === "client_message_rejected") {
        phase.heldBackMessages.push(message);
      }
      return;
    }
    if (phase !== undefined && message.type === "thread_event") {
      if (message.sequence <= phase.lastSentSequence) {
        return;
      }
      if (message.sequence > phase.lastSentSequence + 1) {
        this.#disconnectClientThatMissedEvents(client, phase.lastSentSequence, message.sequence);
        return;
      }
      phase.lastSentSequence = message.sequence;
    }
    client.send(message);
  }

  #disconnectClientThatMissedEvents(
    client: ClientConnection,
    lastSentSequence: number,
    nextSequence: number,
  ): void {
    this.#logger.warn(
      { lastSentSequence, nextSequence },
      "A live client would have missed thread events; disconnecting it so it replays them",
    );
    this.#phases.delete(client);
    this.#whenClientDisconnected();
    client.close(
      standardCloseCodes.internalError,
      "Thread events were recorded that this connection was not sent; reconnect to replay them",
    );
  }
}
