import { randomUUID } from "node:crypto";
import type {
  AssistantTextFragment,
  ClientCommand,
  ClientMessageRejected,
  ControlPlaneToClientMessage,
  RecordedThreadEvent,
  SupervisorConnectionStatus,
  SupervisorToControlPlaneMessage,
  ThreadEvent,
  ThreadEventMessage,
} from "@barrack/protocol";
import { closeCodes, maximumFrameLength, measureLargestThreadEventFrame } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import { standardCloseCodes } from "../standard-close-codes.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type { ClientConnection, SupervisorConnection } from "./connections.js";
import { InProgressAssistantText } from "./in-progress-assistant-text.js";
import { findMissedRange, type MissedRange, readMissedEvents } from "./read-missed-events.js";
import { SerialTaskQueue } from "./serial-task-queue.js";

/** The messages that must still reach a client once its replay is over. */
type HeldBackMessage = ThreadEventMessage | ClientMessageRejected;

/**
 * While a client is being replayed its history, the protocol promises it
 * nothing but the announced events, so thread events recorded meanwhile and
 * rejections of what it sent wait here. Stream fragments and supervisor
 * status are dropped instead: the client is sent the current status and the
 * text streamed so far when its replay ends, which supersede them, so
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

export type ThreadRelayOptions = {
  threadId: string;
  threadEventLog: ThreadEventLog;
  logger: Logger;
  /**
   * Called whenever the relay is left with no supervisor, no clients and no
   * queued work, which is when it can be dropped.
   */
  whenUnused: () => void;
};

/**
 * Coordinates one thread: its supervisor, the clients watching it, and the
 * text of any assistant message still being streamed. It enforces the two
 * rules the product depends on: every thread event is recorded before any
 * client is shown it, and every client sees each thread event exactly once,
 * in sequence order, however it joins.
 *
 * Messages from the supervisor and from clients go through one queue, so the
 * thread's events are recorded and broadcast in the order they arrived.
 * Replaying history to a newly connected client deliberately does not, so a
 * slow replay never delays live traffic for everyone else.
 */
export class ThreadRelay {
  readonly threadId: string;
  readonly #threadEventLog: ThreadEventLog;
  readonly #logger: Logger;
  readonly #whenUnused: () => void;
  readonly #queue = new SerialTaskQueue();
  #queuedTaskCount = 0;
  readonly #inProgressText = new InProgressAssistantText();
  readonly #clientPhases = new Map<ClientConnection, ClientPhase>();
  #supervisor: SupervisorConnection | undefined;

  constructor(options: ThreadRelayOptions) {
    this.threadId = options.threadId;
    this.#threadEventLog = options.threadEventLog;
    this.#logger = options.logger;
    this.#whenUnused = options.whenUnused;
  }

  attachSupervisor(connection: SupervisorConnection): void {
    this.#enqueue("attach a supervisor", async () => {
      const previousSupervisor = this.#supervisor;
      this.#supervisor = connection;
      if (previousSupervisor !== undefined) {
        this.#logger.warn("A newer supervisor connected; closing the previous one");
        previousSupervisor.close(
          closeCodes.supersededByNewerSupervisor,
          "A newer supervisor connected for this thread",
        );
        return;
      }
      this.#broadcastSupervisorConnectionStatus();
    });
  }

  detachSupervisor(connection: SupervisorConnection): void {
    this.#enqueue("detach a supervisor", async () => {
      if (this.#supervisor !== connection) {
        return;
      }
      this.#forgetSupervisor();
    });
  }

  /**
   * Messages from a supervisor that is no longer this thread's supervisor
   * are ignored. That covers one superseded by a newer supervisor, and one
   * dropped because an event it sent could not be recorded.
   */
  receiveFromSupervisor(
    connection: SupervisorConnection,
    message: SupervisorToControlPlaneMessage,
  ): void {
    this.#enqueue(`handle ${message.type} from the supervisor`, async () => {
      if (this.#supervisor !== connection) {
        this.#logger.warn(
          { messageType: message.type },
          "Ignored a message from a supervisor that is no longer attached to this thread",
        );
        return;
      }
      if (message.type === "stream_fragment") {
        this.#relayAssistantTextFragment(message.fragment);
        return;
      }
      await this.#recordAgentEvent(connection, message.event);
    });
  }

  receiveFromClient(connection: ClientConnection, message: ClientCommand): void {
    this.#enqueue(`handle ${message.type} from a client`, async () => {
      if (message.type === "send_user_message") {
        await this.#acceptUserMessage(connection, message.text);
        return;
      }
      this.#forwardInterrupt(connection);
    });
  }

  /**
   * Registers the client at once, then replays the history it missed and
   * switches it to live traffic. A client whose replay fails is detached and
   * disconnected, so it reconnects and tries again.
   */
  attachClient(connection: ClientConnection, lastSeenSequence: number): void {
    const heldBackMessages: HeldBackMessage[] = [];
    this.#clientPhases.set(connection, { name: "replaying", heldBackMessages });
    this.#replayThenGoLive(connection, lastSeenSequence, heldBackMessages).catch(
      (error: unknown) => {
        this.#logger.error({ err: error }, "Could not replay the thread's history to a client");
        this.detachClient(connection);
        connection.close(standardCloseCodes.internalError, "Could not replay the thread's history");
      },
    );
  }

  detachClient(connection: ClientConnection): void {
    this.#clientPhases.delete(connection);
    this.#reportIfUnused();
  }

  /**
   * The client was registered before the log is read, so any event recorded
   * while the replay is under way is held back for it rather than missed;
   * events the replay already covered are then skipped, so none is sent
   * twice. A client that detaches part way is sent nothing more.
   */
  async #replayThenGoLive(
    connection: ClientConnection,
    lastSeenSequence: number,
    heldBackMessages: HeldBackMessage[],
  ): Promise<void> {
    const range = await findMissedRange(
      this.#threadEventLog,
      this.threadId,
      lastSeenSequence,
      this.#logger,
    );
    const wasReplayCompleted = await this.#replayMissedEvents(connection, range);
    if (!wasReplayCompleted) {
      return;
    }
    // From here to the end nothing is awaited, so no event can slip in
    // between the held-back messages and the switch to live.
    this.#clientPhases.set(connection, { name: "live", lastSentSequence: range.lastSequence });
    for (const message of heldBackMessages) {
      this.#sendToClient(connection, message);
    }
    connection.send(this.#supervisorConnectionStatus());
    for (const fragment of this.#inProgressText.toCoalescedFragments()) {
      connection.send({ type: "stream_fragment", fragment });
    }
    this.#logger.info(
      { replayedEventCount: range.lastSequence - range.afterSequence },
      "Client caught up and is live",
    );
  }

  async #recordAgentEvent(supervisor: SupervisorConnection, event: ThreadEvent): Promise<void> {
    if (!this.#fitsInClientFrame(supervisor, event)) {
      return;
    }
    try {
      await this.#recordAndBroadcast(event);
    } catch (error) {
      // The supervisor cannot be told which event was lost, so it is
      // disconnected rather than left believing the event was recorded. It is
      // forgotten at once, not when its socket finishes closing: events it
      // sent after the lost one may already be waiting in the queue, and
      // recording them would leave a silent hole in the thread's history.
      this.#logger.error({ err: error, eventType: event.type }, "Could not record an agent event");
      this.#forgetSupervisor();
      supervisor.close(
        standardCloseCodes.internalError,
        "The control plane could not record an event",
      );
    }
  }

  /**
   * An event recorded but too large to send would break every replay of the
   * thread, so one whose client frame could exceed the limit is refused
   * before it is recorded. A supervisor that leaves the room the protocol
   * asks for (`maximumAgentEventFrameLength`) never sends one; one that does
   * has broken the protocol, and is disconnected as for any invalid message.
   */
  #fitsInClientFrame(supervisor: SupervisorConnection, event: ThreadEvent): boolean {
    const frameLength = measureLargestThreadEventFrame(event);
    if (frameLength <= maximumFrameLength) {
      return true;
    }
    this.#logger.error(
      { eventType: event.type, frameLength, maximumFrameLength },
      "Refused an agent event too large to send to clients; disconnecting the supervisor",
    );
    this.#forgetSupervisor();
    supervisor.close(closeCodes.invalidMessage, "An agent event too large to send to clients");
    return false;
  }

  #forgetSupervisor(): void {
    this.#supervisor = undefined;
    this.#broadcastSupervisorConnectionStatus();
  }

  async #acceptUserMessage(client: ClientConnection, text: string): Promise<void> {
    const supervisor = this.#supervisor;
    if (supervisor === undefined) {
      this.#rejectClientMessage(
        client,
        "No agent is connected to this thread, so the message was not sent. Try again once the agent is connected.",
      );
      return;
    }
    const messageId = randomUUID();
    try {
      await this.#recordAndBroadcast({ type: "user_message", messageId, text });
    } catch (error) {
      this.#logger.error({ err: error }, "Could not record a user message");
      this.#rejectClientMessage(
        client,
        "The message could not be saved, so it was not sent. Please try again.",
      );
      return;
    }
    // Delivered only after it is recorded, so the agent never acts on a
    // message that is missing from the thread's history: that could never be
    // repaired. The opposite failure, a recorded message the agent did not
    // get, is visible in the thread and reported to the sender below, and
    // acknowledged delivery will be able to redeliver it from the log.
    const isAccepted = supervisor.send({ type: "deliver_user_message", messageId, text });
    if (!isAccepted) {
      this.#logger.warn({ messageId }, "Recorded a user message the supervisor could not be sent");
      this.#rejectClientMessage(
        client,
        "The message was recorded but could not be delivered to the agent, because its connection is closing. Send it again once the agent has reconnected.",
      );
      return;
    }
    this.#logger.info({ messageId }, "Delivered a user message to the supervisor");
  }

  #forwardInterrupt(client: ClientConnection): void {
    const supervisor = this.#supervisor;
    if (supervisor === undefined) {
      this.#rejectClientMessage(
        client,
        "No agent is connected to this thread, so there is nothing to interrupt.",
      );
      return;
    }
    const isAccepted = supervisor.send({ type: "interrupt_agent" });
    if (!isAccepted) {
      this.#rejectClientMessage(
        client,
        "The interrupt could not be delivered to the agent, because its connection is closing. Try again once the agent has reconnected.",
      );
      return;
    }
    this.#logger.info("Forwarded an interrupt to the supervisor");
  }

  async #recordAndBroadcast(event: ThreadEvent): Promise<RecordedThreadEvent> {
    const recordedEvent = await this.#threadEventLog.append(this.threadId, event);
    this.#logger.info(
      { sequence: recordedEvent.sequence, eventType: event.type },
      "Recorded a thread event",
    );
    this.#forgetTextSupersededBy(event);
    this.#broadcast({ type: "thread_event", ...recordedEvent });
    return recordedEvent;
  }

  #forgetTextSupersededBy(event: ThreadEvent): void {
    if (event.type === "assistant_message") {
      this.#inProgressText.discardMessage(event.messageId);
    }
    if (event.type === "agent_run_settled" || event.type === "agent_failed") {
      this.#inProgressText.discardCurrentMessage();
    }
  }

  #relayAssistantTextFragment(fragment: AssistantTextFragment): void {
    if (this.#inProgressText.append(fragment) === "exceeded_limit") {
      this.#logger.warn(
        { messageId: fragment.messageId },
        "Stopped keeping streamed text for an assistant message that went past a size limit",
      );
    }
    this.#broadcast({ type: "stream_fragment", fragment });
  }

  #rejectClientMessage(client: ClientConnection, reason: string): void {
    this.#logger.info({ reason }, "Rejected a client message");
    this.#sendToClient(client, { type: "client_message_rejected", reason });
  }

  #broadcastSupervisorConnectionStatus(): void {
    const status = this.#supervisorConnectionStatus();
    this.#logger.info(
      { isSupervisorConnected: status.isSupervisorConnected },
      "Supervisor connection changed",
    );
    this.#broadcast(status);
  }

  #supervisorConnectionStatus(): SupervisorConnectionStatus {
    return {
      type: "supervisor_connection_status",
      isSupervisorConnected: this.#supervisor !== undefined,
    };
  }

  #broadcast(message: ControlPlaneToClientMessage): void {
    for (const client of this.#clientPhases.keys()) {
      this.#sendToClient(client, message);
    }
  }

  #sendToClient(client: ClientConnection, message: ControlPlaneToClientMessage): void {
    const phase = this.#clientPhases.get(client);
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
    this.detachClient(client);
    client.close(
      standardCloseCodes.internalError,
      "Thread events were recorded that this connection was not sent; reconnect to replay them",
    );
  }

  /**
   * Sends the announcement, then the announced events as they are read from
   * the log a page at a time. Returns false if the client detached before
   * the replay was over.
   */
  async #replayMissedEvents(client: ClientConnection, range: MissedRange): Promise<boolean> {
    if (!this.#clientPhases.has(client)) {
      return false;
    }
    await client.sendAndWaitUntilWritten({
      type: "replay_announcement",
      firstSequence: range.afterSequence + 1,
      lastSequence: range.lastSequence,
    });
    const missedEvents = readMissedEvents(this.#threadEventLog, this.threadId, range);
    for await (const recordedEvent of missedEvents) {
      if (!this.#clientPhases.has(client)) {
        return false;
      }
      await client.sendAndWaitUntilWritten({ type: "thread_event", ...recordedEvent });
    }
    return this.#clientPhases.has(client);
  }

  #enqueue(description: string, task: () => Promise<void>): void {
    this.#queuedTaskCount += 1;
    this.#queue
      .enqueue(task)
      .catch((error: unknown) => {
        this.#logger.error({ err: error }, `Failed to ${description}`);
      })
      .finally(() => {
        this.#queuedTaskCount -= 1;
        this.#reportIfUnused();
      });
  }

  /**
   * The check and the callback run in one synchronous step, as does the
   * registry's attaching of a peer, so no peer can attach between the relay
   * being found unused and the registry dropping it.
   */
  #reportIfUnused(): void {
    const isUnused =
      this.#supervisor === undefined &&
      this.#clientPhases.size === 0 &&
      this.#queuedTaskCount === 0;
    if (isUnused) {
      this.#whenUnused();
    }
  }
}
